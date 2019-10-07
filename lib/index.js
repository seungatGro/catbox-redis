
'use strict';

// Load modules

const Redis = require('ioredis');
const Hoek = require('hoek');
const LZ4 = require('lz4');


// Declare internals

const internals = {};


internals.defaults = {
    host: '127.0.0.1',
    port: 6379
};


exports = module.exports = internals.Connection = function (options) {

    Hoek.assert(this.constructor === internals.Connection, 'Redis cache client must be instantiated using new');

    this.settings = Object.assign({}, internals.defaults, options);
    this.client = options.client || null;
    return this;
};


internals.Connection.prototype.start = function (callback) {

    callback = Hoek.once(callback);

    const self = this;
    if (this.client) {
        return Hoek.nextTick(callback)();
    }

    let client;

    const options = {
        password: this.settings.password,
        db: this.settings.database || this.settings.db
    };

    if (this.settings.sentinels && this.settings.sentinels.length) {
        options.sentinels = this.settings.sentinels;
        options.name = this.settings.sentinelName;
        client = Redis.createClient(options);
    }
    else if (this.settings.url) {
        client = Redis.createClient(this.settings.url, options);
    }
    else if (this.settings.socket) {
        client = Redis.createClient(this.settings.socket, options);
    }
    else {
        client = Redis.createClient(this.settings.port, this.settings.host, options);
    }

    // Listen to errors

    client.on('error', (err) => {

        if (!self.client) {                             // Failed to connect
            client.end(false);
            return callback(err);
        }
    });

    // Wait for connection

    client.once('ready', () => {

        self.client = client;
        return callback();
    });
};


internals.Connection.prototype.stop = function () {

    if (this.client) {
        this.client.removeAllListeners();
        this.client.quit();
        this.client = null;
    }
};


internals.Connection.prototype.isReady = function () {

    return !!this.client && this.client.status === 'ready';
};


internals.Connection.prototype.validateSegmentName = function (name) {

    if (!name) {
        return new Error('Empty string');
    }

    if (name.indexOf('\0') !== -1) {
        return new Error('Includes null character');
    }

    return null;
};


internals.Connection.prototype.get = function (key, callback) {

    if (!this.client) {
        return callback(new Error('Connection not started'));
    }

    this.client.getBuffer(this.generateKey(key), (err, result) => {

        if (err) {
            return callback(err);
        }

        if (!result) {
            return callback(null, null);
        }

        let envelope = null;

        try {
          let hrstart = process.hrtime()
          let uncompressedResult = LZ4.decode(result);
          let hrend = process.hrtime(hrstart);
          envelope = JSON.parse(uncompressedResult.toString());

          console.log("\x1b[35m");
          console.log("Time to decompress: %ds %dms", hrend[0], hrend[1] / 1000000);
          console.log("\x1b[0m");

        }
        catch (err) {
          console.log(err);
        }     // Handled by validation below

        if (!envelope) {
            return callback(new Error('Bad envelope content'));
        }

        if (!envelope.item ||
            !envelope.stored) {

            return callback(new Error('Incorrect envelope structure'));
        }

        return callback(null, envelope);
    });
};


internals.Connection.prototype.set = function (key, value, ttl, callback) {

    const self = this;

    if (!this.client) {
        return callback(new Error('Connection not started'));
    }

    const envelope = {
        item: value,
        stored: Date.now(),
        ttl
    };

    const cacheKey = this.generateKey(key);

    let compressedEnvelope = null;

    try {
      let stringifiedEnvelope = JSON.stringify(envelope);
      let uncompressedBuffer = Buffer.from(stringifiedEnvelope);
      let hrstart = process.hrtime();
      compressedEnvelope = LZ4.encode(uncompressedBuffer);
      let hrend = process.hrtime(hrstart);
      console.log("\x1b[35m");
      console.log('Time to compress: %ds %dms', hrend[0], hrend[1] / 1000000);
      console.log("Uncompressed: ", uncompressedBuffer.length,
        "Compressed: ", compressedEnvelope.length,
        "Compression ratio: ", compressedEnvelope.length / uncompressedBuffer.length,
      "\x1b[0m");
    }
    catch (err) {
        console.log(err);
        return callback(err);
    }

    this.client.psetex(cacheKey, ttl, compressedEnvelope, (err) => {
        if (err) {
            return callback(err);
        }
    });
};


internals.Connection.prototype.drop = function (key, callback) {

    if (!this.client) {
        return callback(new Error('Connection not started'));
    }

    this.client.del(this.generateKey(key), (err) => {

        return callback(err);
    });
};


internals.Connection.prototype.generateKey = function (key) {
    const parts = [];

    if (this.settings.partition) {
        parts.push(this.settings.partition);
    }
    parts.push(key.segment);
    parts.push(key.id);

    return parts.join(':');
};
