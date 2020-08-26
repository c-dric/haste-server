const fs = require('fs');
const winston = require('winston');
const minify = require('babel-minify');
const st = require('st');
const app = require('express')();
const expressRateLimit = require('express-rate-limit');

const DocumentHandler = require('./lib/document_handler');
const HasteUtils = require('./lib/util');

const utils = new HasteUtils();

//set up logger
//only Console for now, gotta utilize config.json in the future
winston.add(new winston.transports.Console({
    level: 'silly',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => `${info.level}: ${info.message} ${utils.stringifyJSONMessagetoLogs(info)}`)
    ),
}));

//load config and set some defaults
const config = require('./config');
config.port = config.port || 7777;
config.host = config.host || '127.0.0.1';

//defaulting storage type to file
if (!config.storage){
    config.storage = {
        type: 'file',
        path: './data'
    };
}
if (!config.storage.type) config.storage.type = 'file';

let preferredStore;
if (process.env.REDISTOGO_URL && config.storage.type == 'redis'){
    let redisClient = require('redis-url').connect(process.env.REDISTOGO_URL);
    let Store = require('./lib/document_stores/redis');
    preferredStore = new Store(config.storage, redisClient);
}
else {
    let Store = require(`./lib/document_stores/${config.storage.type}`);
    preferredStore = new Store(config.storage);
}

//compress static javascript assets
if (config.recompressStaticAssets){
    let files = fs.readdirSync('./static');
    //https://regex101.com/r/5cJagJ/2
    for (const file of files){
        let info = file.match(/^((.+)(?<!\.min)(\.js))$/);
        if (!info) continue;
        const dest = `${info[2]}.min${info[3]}`;
        const code = fs.readFileSync(`./static/${file}`, 'utf8');
        const {code: newCode} = minify(code);
        fs.writeFileSync(`./static/${dest}`, newCode, 'utf8');
        winston.info(`compressed ${file} into ${dest}`);
    }
}

(async function(){

//send the static documents into the preferred store, skipping expirations
for (const name in config.documents){
    let path = config.documents[name];
    winston.info('loading static document', { name: name, path: path });
    let data = fs.readFileSync(path, 'utf8');
    if (data){
		await preferredStore.set(name, data, doc => winston.debug('loaded static document', { success: doc }), true);
    }
    else {
        winston.warn('failed to load static document', { name: name, path: path });
    }
}

//pick up a key generator
let pwOptions = config.keyGenerator || new Object;
pwOptions.type = pwOptions.type || 'random';
let Gen = require(`./lib/key_generators/${pwOptions.type}`);
let keyGenerator = new Gen(pwOptions);

//configure the document handler
let documentHandler = new DocumentHandler({
    store: preferredStore,
    maxLength: config.maxLength,
    keyLength: config.keyLength,
    keyGenerator: keyGenerator
});

//rate limit all requests
if (config.rateLimits) app.use(expressRateLimit(config.rateLimits));

//try API first

//get raw documents
app.get('/raw/:id', async (req, res) => {
    const key = req.params.id.split('.')[0];
    const skipExpire = Boolean(config.documents[key]);
	return await documentHandler.handleGetRaw(key, res, skipExpire);
});

//add documents
app.post('/documents', async (req, res) => {
	return await documentHandler.handlePost(req, res);
});

//get documents
app.get('/documents/:id', async (req, res) =>  {
    const key = req.params.id.split('.')[0];
    const skipExpire = Boolean(config.documents[key]);
	return await documentHandler.handleGet(key, res, skipExpire);
});

//try static next
app.use(st({
    path: './static',
    passthrough: true,
    index: false
}));

//then we can loop back - and everything else should be a token,
//so route it back to /
app.get('/:id', (req, res, next) => {
    req.sturl = '/';
    next();
});

//and match index
app.use(st({
  content: { maxAge: config.staticMaxAge },
    path: './static',
    index: 'index.html'
}));

app.listen(config.port, config.host, () => winston.info(`listening on ${config.host}:${config.port}`));

})();