var fs = require("fs");
var bunyan = require("bunyan");
var ns = require('continuation-local-storage');

var RawStream = require("./LoggerRawStream.js");
var Middlewares = require("./ExpressMiddlewares.js");

const NAMESPACE = "log4bro.ns";
const CORRELATION_HEADER = "correlation-id";
const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

function ServiceLogger(loggerName, silence, logDir, productionMode, dockerMode, varKey, logFieldOptions, level, serviceName) {

    if(typeof loggerName === "object" && arguments.length === 1){
        productionMode = loggerName.production || loggerName.productionMode; //support fallback
        logDir = loggerName.logDir;
        silence = loggerName.silence;
        dockerMode = loggerName.docker || loggerName.dockerMode; //support fallback
        varKey = loggerName.varKey;
        logFieldOptions = loggerName.logFieldOptions;
        level = loggerName.level || loggerName.logLevel; //support fallback to older key named "logLevel"
        serviceName = loggerName.serviceName;

        loggerName = loggerName.name; //last
    }

    if(level && LOG_LEVELS.indexOf(level) === -1){
        console.log("[log4bro] level is not a supported logLevel: " + level + ", defaulting to INFO.");
        level = "INFO";
    }

    this.productionMode = productionMode || false;
    this.varKey = varKey || "LOG";
    this.dockerMode = dockerMode || false;
    this.logFieldOptions = logFieldOptions || null;
    this.silence = silence || false;
    this.logDir = logDir || "logs";
    this.logLevel = level || (productionMode ? "WARN" : "DEBUG"); //level -> logLevel (dockerconfig cannot set camelcase)
    this.serviceName = serviceName || "undefined";

    this.skipDebug = false;
    if(this.silence || (this.productionMode &&
        !(this.logLevel === "TRACE" || this.logLevel === "DEBUG"))){
        this.skipDebug = true;
    }

    if (!loggerName && !this.productionMode) {
        this.loggerName = loggerName || "dev";
    } else {
        this.loggerName = loggerName || "prod";
    }

    this._streams = null;
    this.LOG = this._createLogger();

    this.LOG.info("[log4bro] Logger is: in-prod=" + this.productionMode +
    ", in-docker:" + this.dockerMode +
    ", level=" + this.logLevel +
    ", skipDebug=" + this.skipDebug);

    this.setGlobal();
}

ServiceLogger.prototype._createLogger = function(){

    this._streams = []; //clear

    this._streams.push(
        {
            "type": "raw",
            "level": this.logLevel,
            "stream": new RawStream(null, this.logFieldOptions, this.dockerMode) //will only write to console/stdout
        }
    );

    if(!this.dockerMode){

        //console.log("[log4bro] Logger is not in docker mode.");
        this.createLoggingDir();

        this._streams.push({
            "type": "raw",
            "level": this.logLevel,
            "stream": new RawStream(this.logDir + "/service-log.json", this.logFieldOptions) //will only write to logfile
        });
    }

    return bunyan.createLogger({
        "name": this.loggerName,
        "streams": this._streams,
        "src": false
    });
};

ServiceLogger.prototype.changeLogLevel = function(level){

    if(level && LOG_LEVELS.indexOf(level) === -1){
        this.LOG.error("[log4bro] level is not a supported logLevel: " + level + ", defaulting to INFO.");
        return;
    }

    if(level === "DEBUG" || level === "TRACE"){
        this.skipDebug = false;
    } else {
        this.skipDebug = true;
    }

    this.LOG.info("[log4bro] changing loglevel from " + this.logLevel + " to " + level + ".");
    this.logLevel = level;
    this.LOG = this._createLogger();
};

ServiceLogger.prototype.createLoggingDir = function() {

    if (!fs.existsSync(this.logDir)) {
        //console.log("[log4bro] Logs folder does not exists creating " + this.logDir + " make sure to set path in blammo.xml.");
        fs.mkdirSync(this.logDir);
        return;
    }

    //console.log("[log4bro] Logs folder exists, clearing " + this.logDir);

    var files = null;
    try { files = fs.readdirSync(this.logDir); }
    catch (e) { return; }

    if (files.length > 0)
        for (var i = 0; i < files.length; i++) {
            var filePath = this.logDir + "/" + files[i];
            if (fs.statSync(filePath).isFile())
                fs.unlinkSync(filePath);
            else
                fs.rmDir(filePath);
        }
};

ServiceLogger.prototype.applyMiddlewareAccessLog = function(expressApp){

    if(!expressApp || typeof expressApp !== "function"){
        throw new Error("[log4bro] ExpressApp is null or not an object, make sure you pass an instance of express() to applyMiddleware.");
    }

    expressApp.use(Middlewares.accessLogMiddleware(this.serviceName, this.dockerMode));
    return expressApp;
};

ServiceLogger.prototype.applyMiddlewareAccessLogFile = function(expressApp, logFilePath){

    if(!expressApp || typeof expressApp !== "function"){
        throw new Error("[log4bro] ExpressApp is null or not an object, make sure you pass an instance of express() to applyMiddleware.");
    }

    if(!logFilePath){
        throw new Error("[log4bro] logFilePath is empty on applyMiddlewareAccessLogFile.");
    }

    expressApp.use(Middlewares.accessLogMiddlewareFile(logFilePath));
    return expressApp;
};

ServiceLogger.prototype.applyMiddlewareCorrelationId = function(expressApp){

    if(!expressApp || typeof expressApp !== "function"){
        throw new Error("[log4bro] ExpressApp is null or not an object, make sure you pass an instance of express() to applyMiddleware.");
    }

    expressApp.use(Middlewares.correlationIdMiddleware(NAMESPACE, CORRELATION_HEADER, this.varKey, this.dockerMode));
    return expressApp;
};

ServiceLogger.prototype.setGlobal = function() {
    global[this.varKey] = this;
};

ServiceLogger.prototype.trace = function(message) {
    if (this.skipDebug) return; //safe memory & cpu
    this.LOG.trace(this.enhance(message));
};

ServiceLogger.prototype.debug = function(message) {
    if (this.skipDebug) return; //safe memory & cpu
    this.LOG.debug(this.enhance(message));
};

ServiceLogger.prototype.info = function(message) {
    if (this.silence) return;
    this.LOG.info(this.enhance(message));
};

ServiceLogger.prototype.warn = function(message) {
    if (this.silence) return;
    this.LOG.warn(this.enhance(message));
};

ServiceLogger.prototype.error = function(message) {
    if (this.silence) return;
    this.LOG.error(this.enhance(message));
};

ServiceLogger.prototype.fatal = function(message) {
    if (this.silence) return;
    this.LOG.fatal(this.enhance(message));
};

ServiceLogger.prototype.raw = function(messageObject, support){

    if(typeof messageObject !== "object"){
        throw new Error("Logger.raw(obj) must be called with an object.");
    }

    if (this.silence) return;

    support = support || false;

    this._streams.forEach(function(stream){
        if(stream && stream.stream){
            stream.stream.write(messageObject, support ?
                RawStream.OVERWRITE_MODES.ADAPT :
                RawStream.OVERWRITE_MODES.NONE);
        }
    });
};

ServiceLogger.prototype.enhance = function(message) {
    /* enhance */

    var correlationId = null;
    var namespace = ns.getNamespace(NAMESPACE);
    if (namespace) {
        correlationId = namespace.get(CORRELATION_HEADER);
    }

    if(typeof message === "object"){

        if (correlationId) {
            message["correlation-id"] = correlationId;
        }

        if(Object.keys(message).length <= 15){
            message = JSON.stringify(message);
        } else {
            message = "[Object object, with more than 15 keys.]";
        }
    } else {
        
        if(correlationId){
            message = JSON.stringify({ "correlation-id": correlationId, "msg": message });
        }
    }

    return message;
};

module.exports = ServiceLogger;