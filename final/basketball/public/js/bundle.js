(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (process,Buffer){
'use strict';

var net = require('net');
var tls = require('tls');
var util = require('util');
var utils = require('./lib/utils');
var Command = require('./lib/command');
var Queue = require('double-ended-queue');
var errorClasses = require('./lib/customErrors');
var EventEmitter = require('events');
var Parser = require('redis-parser');
var commands = require('redis-commands');
var debug = require('./lib/debug');
var unifyOptions = require('./lib/createClient');
var SUBSCRIBE_COMMANDS = {
    subscribe: true,
    unsubscribe: true,
    psubscribe: true,
    punsubscribe: true
};

// Newer Node.js versions > 0.10 return the EventEmitter right away and using .EventEmitter was deprecated
if (typeof EventEmitter !== 'function') {
    EventEmitter = EventEmitter.EventEmitter;
}

function noop () {}

function handle_detect_buffers_reply (reply, command, buffer_args) {
    if (buffer_args === false || this.message_buffers) {
        // If detect_buffers option was specified, then the reply from the parser will be a buffer.
        // If this command did not use Buffer arguments, then convert the reply to Strings here.
        reply = utils.reply_to_strings(reply);
    }

    if (command === 'hgetall') {
        reply = utils.reply_to_object(reply);
    }
    return reply;
}

exports.debug_mode = /\bredis\b/i.test(process.env.NODE_DEBUG);

// Attention: The second parameter might be removed at will and is not officially supported.
// Do not rely on this
function RedisClient (options, stream) {
    // Copy the options so they are not mutated
    options = utils.clone(options);
    EventEmitter.call(this);
    var cnx_options = {};
    var self = this;
    /* istanbul ignore next: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
    for (var tls_option in options.tls) {
        cnx_options[tls_option] = options.tls[tls_option];
        // Copy the tls options into the general options to make sure the address is set right
        if (tls_option === 'port' || tls_option === 'host' || tls_option === 'path' || tls_option === 'family') {
            options[tls_option] = options.tls[tls_option];
        }
    }
    if (stream) {
        // The stream from the outside is used so no connection from this side is triggered but from the server this client should talk to
        // Reconnect etc won't work with this. This requires monkey patching to work, so it is not officially supported
        options.stream = stream;
        this.address = '"Private stream"';
    } else if (options.path) {
        cnx_options.path = options.path;
        this.address = options.path;
    } else {
        cnx_options.port = +options.port || 6379;
        cnx_options.host = options.host || '127.0.0.1';
        cnx_options.family = (!options.family && net.isIP(cnx_options.host)) || (options.family === 'IPv6' ? 6 : 4);
        this.address = cnx_options.host + ':' + cnx_options.port;
    }
    // Warn on misusing deprecated functions
    if (typeof options.retry_strategy === 'function') {
        if ('max_attempts' in options) {
            self.warn('WARNING: You activated the retry_strategy and max_attempts at the same time. This is not possible and max_attempts will be ignored.');
            // Do not print deprecation warnings twice
            delete options.max_attempts;
        }
        if ('retry_max_delay' in options) {
            self.warn('WARNING: You activated the retry_strategy and retry_max_delay at the same time. This is not possible and retry_max_delay will be ignored.');
            // Do not print deprecation warnings twice
            delete options.retry_max_delay;
        }
    }

    this.connection_options = cnx_options;
    this.connection_id = RedisClient.connection_id++;
    this.connected = false;
    this.ready = false;
    if (options.socket_nodelay === undefined) {
        options.socket_nodelay = true;
    } else if (!options.socket_nodelay) { // Only warn users with this set to false
        self.warn(
            'socket_nodelay is deprecated and will be removed in v.3.0.0.\n' +
            'Setting socket_nodelay to false likely results in a reduced throughput. Please use .batch for pipelining instead.\n' +
            'If you are sure you rely on the NAGLE-algorithm you can activate it by calling client.stream.setNoDelay(false) instead.'
        );
    }
    if (options.socket_keepalive === undefined) {
        options.socket_keepalive = true;
    }
    for (var command in options.rename_commands) {
        options.rename_commands[command.toLowerCase()] = options.rename_commands[command];
    }
    options.return_buffers = !!options.return_buffers;
    options.detect_buffers = !!options.detect_buffers;
    // Override the detect_buffers setting if return_buffers is active and print a warning
    if (options.return_buffers && options.detect_buffers) {
        self.warn('WARNING: You activated return_buffers and detect_buffers at the same time. The return value is always going to be a buffer.');
        options.detect_buffers = false;
    }
    if (options.detect_buffers) {
        // We only need to look at the arguments if we do not know what we have to return
        this.handle_reply = handle_detect_buffers_reply;
    }
    this.should_buffer = false;
    this.max_attempts = options.max_attempts | 0;
    if ('max_attempts' in options) {
        self.warn(
            'max_attempts is deprecated and will be removed in v.3.0.0.\n' +
            'To reduce the amount of options and the improve the reconnection handling please use the new `retry_strategy` option instead.\n' +
            'This replaces the max_attempts and retry_max_delay option.'
        );
    }
    this.command_queue = new Queue(); // Holds sent commands to de-pipeline them
    this.offline_queue = new Queue(); // Holds commands issued but not able to be sent
    this.pipeline_queue = new Queue(); // Holds all pipelined commands
    // ATTENTION: connect_timeout should change in v.3.0 so it does not count towards ending reconnection attempts after x seconds
    // This should be done by the retry_strategy. Instead it should only be the timeout for connecting to redis
    this.connect_timeout = +options.connect_timeout || 3600000; // 60 * 60 * 1000 ms
    this.enable_offline_queue = options.enable_offline_queue === false ? false : true;
    this.retry_max_delay = +options.retry_max_delay || null;
    if ('retry_max_delay' in options) {
        self.warn(
            'retry_max_delay is deprecated and will be removed in v.3.0.0.\n' +
            'To reduce the amount of options and the improve the reconnection handling please use the new `retry_strategy` option instead.\n' +
            'This replaces the max_attempts and retry_max_delay option.'
        );
    }
    this.initialize_retry_vars();
    this.pub_sub_mode = 0;
    this.subscription_set = {};
    this.monitoring = false;
    this.message_buffers = false;
    this.closing = false;
    this.server_info = {};
    this.auth_pass = options.auth_pass || options.password;
    this.selected_db = options.db; // Save the selected db here, used when reconnecting
    this.old_state = null;
    this.fire_strings = true; // Determine if strings or buffers should be written to the stream
    this.pipeline = false;
    this.sub_commands_left = 0;
    this.times_connected = 0;
    this.buffers = options.return_buffers || options.detect_buffers;
    this.options = options;
    this.reply = 'ON'; // Returning replies is the default
    // Init parser
    this.reply_parser = create_parser(this);
    this.create_stream();
    // The listeners will not be attached right away, so let's print the deprecation message while the listener is attached
    this.on('newListener', function (event) {
        if (event === 'idle') {
            this.warn(
                'The idle event listener is deprecated and will likely be removed in v.3.0.0.\n' +
                'If you rely on this feature please open a new ticket in node_redis with your use case'
            );
        } else if (event === 'drain') {
            this.warn(
                'The drain event listener is deprecated and will be removed in v.3.0.0.\n' +
                'If you want to keep on listening to this event please listen to the stream drain event directly.'
            );
        } else if (event === 'message_buffer' || event === 'pmessage_buffer' || event === 'messageBuffer' || event === 'pmessageBuffer' && !this.buffers) {
            this.message_buffers = true;
            this.handle_reply = handle_detect_buffers_reply;
            this.reply_parser = create_parser(this);
        }
    });
}
util.inherits(RedisClient, EventEmitter);

RedisClient.connection_id = 0;

function create_parser (self) {
    return new Parser({
        returnReply: function (data) {
            self.return_reply(data);
        },
        returnError: function (err) {
            // Return a ReplyError to indicate Redis returned an error
            self.return_error(err);
        },
        returnFatalError: function (err) {
            // Error out all fired commands. Otherwise they might rely on faulty data. We have to reconnect to get in a working state again
            // Note: the execution order is important. First flush and emit, then create the stream
            err.message += '. Please report this.';
            self.ready = false;
            self.flush_and_error({
                message: 'Fatal error encountert. Command aborted.',
                code: 'NR_FATAL'
            }, {
                error: err,
                queues: ['command_queue']
            });
            self.emit('error', err);
            self.create_stream();
        },
        returnBuffers: self.buffers || self.message_buffers,
        name: self.options.parser || 'javascript',
        stringNumbers: self.options.string_numbers || false
    });
}

/******************************************************************************

    All functions in here are internal besides the RedisClient constructor
    and the exported functions. Don't rely on them as they will be private
    functions in node_redis v.3

******************************************************************************/

// Attention: the function name "create_stream" should not be changed, as other libraries need this to mock the stream (e.g. fakeredis)
RedisClient.prototype.create_stream = function () {
    var self = this;

    if (this.options.stream) {
        // Only add the listeners once in case of a reconnect try (that won't work)
        if (this.stream) {
            return;
        }
        this.stream = this.options.stream;
    } else {
        // On a reconnect destroy the former stream and retry
        if (this.stream) {
            this.stream.removeAllListeners();
            this.stream.destroy();
        }

        /* istanbul ignore if: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
        if (this.options.tls) {
            this.stream = tls.connect(this.connection_options);
        } else {
            this.stream = net.createConnection(this.connection_options);
        }
    }

    if (this.options.connect_timeout) {
        this.stream.setTimeout(this.connect_timeout, function () {
            // Note: This is only tested if a internet connection is established
            self.retry_totaltime = self.connect_timeout;
            self.connection_gone('timeout');
        });
    }

    /* istanbul ignore next: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
    var connect_event = this.options.tls ? 'secureConnect' : 'connect';
    this.stream.once(connect_event, function () {
        this.removeAllListeners('timeout');
        self.times_connected++;
        self.on_connect();
    });

    this.stream.on('data', function (buffer_from_socket) {
        // The buffer_from_socket.toString() has a significant impact on big chunks and therefore this should only be used if necessary
        debug('Net read ' + self.address + ' id ' + self.connection_id); // + ': ' + buffer_from_socket.toString());
        self.reply_parser.execute(buffer_from_socket);
        self.emit_idle();
    });

    this.stream.on('error', function (err) {
        self.on_error(err);
    });

    /* istanbul ignore next: difficult to test and not important as long as we keep this listener */
    this.stream.on('clientError', function (err) {
        debug('clientError occured');
        self.on_error(err);
    });

    this.stream.once('close', function (hadError) {
        self.connection_gone('close');
    });

    this.stream.once('end', function () {
        self.connection_gone('end');
    });

    this.stream.on('drain', function () {
        self.drain();
    });

    if (this.options.socket_nodelay) {
        this.stream.setNoDelay();
    }

    // Fire the command before redis is connected to be sure it's the first fired command
    if (this.auth_pass !== undefined) {
        this.ready = true;
        this.auth(this.auth_pass);
        this.ready = false;
    }
};

RedisClient.prototype.handle_reply = function (reply, command) {
    if (command === 'hgetall') {
        reply = utils.reply_to_object(reply);
    }
    return reply;
};

RedisClient.prototype.cork = noop;
RedisClient.prototype.uncork = noop;

RedisClient.prototype.initialize_retry_vars = function () {
    this.retry_timer = null;
    this.retry_totaltime = 0;
    this.retry_delay = 200;
    this.retry_backoff = 1.7;
    this.attempts = 1;
};

RedisClient.prototype.warn = function (msg) {
    var self = this;
    // Warn on the next tick. Otherwise no event listener can be added
    // for warnings that are emitted in the redis client constructor
    process.nextTick(function () {
        if (self.listeners('warning').length !== 0) {
            self.emit('warning', msg);
        } else {
            console.warn('node_redis:', msg);
        }
    });
};

// Flush provided queues, erroring any items with a callback first
RedisClient.prototype.flush_and_error = function (error_attributes, options) {
    options = options || {};
    var aggregated_errors = [];
    var queue_names = options.queues || ['command_queue', 'offline_queue']; // Flush the command_queue first to keep the order intakt
    for (var i = 0; i < queue_names.length; i++) {
        // If the command was fired it might have been processed so far
        if (queue_names[i] === 'command_queue') {
            error_attributes.message += ' It might have been processed.';
        } else { // As the command_queue is flushed first, remove this for the offline queue
            error_attributes.message = error_attributes.message.replace(' It might have been processed.', '');
        }
        // Don't flush everything from the queue
        for (var command_obj = this[queue_names[i]].shift(); command_obj; command_obj = this[queue_names[i]].shift()) {
            var err = new errorClasses.AbortError(error_attributes);
            if (command_obj.error) {
                err.stack = err.stack + command_obj.error.stack.replace(/^Error.*?\n/, '\n');
            }
            err.command = command_obj.command.toUpperCase();
            if (command_obj.args && command_obj.args.length) {
                err.args = command_obj.args;
            }
            if (options.error) {
                err.origin = options.error;
            }
            if (typeof command_obj.callback === 'function') {
                command_obj.callback(err);
            } else {
                aggregated_errors.push(err);
            }
        }
    }
    // Currently this would be a breaking change, therefore it's only emitted in debug_mode
    if (exports.debug_mode && aggregated_errors.length) {
        var error;
        if (aggregated_errors.length === 1) {
            error = aggregated_errors[0];
        } else {
            error_attributes.message = error_attributes.message.replace('It', 'They').replace(/command/i, '$&s');
            error = new errorClasses.AggregateError(error_attributes);
            error.errors = aggregated_errors;
        }
        this.emit('error', error);
    }
};

RedisClient.prototype.on_error = function (err) {
    if (this.closing) {
        return;
    }

    err.message = 'Redis connection to ' + this.address + ' failed - ' + err.message;
    debug(err.message);
    this.connected = false;
    this.ready = false;

    // Only emit the error if the retry_stategy option is not set
    if (!this.options.retry_strategy) {
        this.emit('error', err);
    }
    // 'error' events get turned into exceptions if they aren't listened for. If the user handled this error
    // then we should try to reconnect.
    this.connection_gone('error', err);
};

RedisClient.prototype.on_connect = function () {
    debug('Stream connected ' + this.address + ' id ' + this.connection_id);

    this.connected = true;
    this.ready = false;
    this.emitted_end = false;
    this.stream.setKeepAlive(this.options.socket_keepalive);
    this.stream.setTimeout(0);

    this.emit('connect');
    this.initialize_retry_vars();

    if (this.options.no_ready_check) {
        this.on_ready();
    } else {
        this.ready_check();
    }
};

RedisClient.prototype.on_ready = function () {
    var self = this;

    debug('on_ready called ' + this.address + ' id ' + this.connection_id);
    this.ready = true;

    this.cork = function () {
        self.pipeline = true;
        if (self.stream.cork) {
            self.stream.cork();
        }
    };
    this.uncork = function () {
        if (self.fire_strings) {
            self.write_strings();
        } else {
            self.write_buffers();
        }
        self.pipeline = false;
        self.fire_strings = true;
        if (self.stream.uncork) {
            // TODO: Consider using next tick here. See https://github.com/NodeRedis/node_redis/issues/1033
            self.stream.uncork();
        }
    };

    // Restore modal commands from previous connection. The order of the commands is important
    if (this.selected_db !== undefined) {
        this.internal_send_command(new Command('select', [this.selected_db]));
    }
    if (this.monitoring) { // Monitor has to be fired before pub sub commands
        this.internal_send_command(new Command('monitor', []));
    }
    var callback_count = Object.keys(this.subscription_set).length;
    if (!this.options.disable_resubscribing && callback_count) {
        // only emit 'ready' when all subscriptions were made again
        // TODO: Remove the countdown for ready here. This is not coherent with all other modes and should therefore not be handled special
        // We know we are ready as soon as all commands were fired
        var callback = function () {
            callback_count--;
            if (callback_count === 0) {
                self.emit('ready');
            }
        };
        debug('Sending pub/sub on_ready commands');
        for (var key in this.subscription_set) {
            var command = key.slice(0, key.indexOf('_'));
            var args = this.subscription_set[key];
            this[command]([args], callback);
        }
        this.send_offline_queue();
        return;
    }
    this.send_offline_queue();
    this.emit('ready');
};

RedisClient.prototype.on_info_cmd = function (err, res) {
    if (err) {
        if (err.message === "ERR unknown command 'info'") {
            this.on_ready();
            return;
        }
        err.message = 'Ready check failed: ' + err.message;
        this.emit('error', err);
        return;
    }

    /* istanbul ignore if: some servers might not respond with any info data. This is just a safety check that is difficult to test */
    if (!res) {
        debug('The info command returned without any data.');
        this.on_ready();
        return;
    }

    if (!this.server_info.loading || this.server_info.loading === '0') {
        // If the master_link_status exists but the link is not up, try again after 50 ms
        if (this.server_info.master_link_status && this.server_info.master_link_status !== 'up') {
            this.server_info.loading_eta_seconds = 0.05;
        } else {
            // Eta loading should change
            debug('Redis server ready.');
            this.on_ready();
            return;
        }
    }

    var retry_time = +this.server_info.loading_eta_seconds * 1000;
    if (retry_time > 1000) {
        retry_time = 1000;
    }
    debug('Redis server still loading, trying again in ' + retry_time);
    setTimeout(function (self) {
        self.ready_check();
    }, retry_time, this);
};

RedisClient.prototype.ready_check = function () {
    var self = this;
    debug('Checking server ready state...');
    // Always fire this info command as first command even if other commands are already queued up
    this.ready = true;
    this.info(function (err, res) {
        self.on_info_cmd(err, res);
    });
    this.ready = false;
};

RedisClient.prototype.send_offline_queue = function () {
    for (var command_obj = this.offline_queue.shift(); command_obj; command_obj = this.offline_queue.shift()) {
        debug('Sending offline command: ' + command_obj.command);
        this.internal_send_command(command_obj);
    }
    this.drain();
};

var retry_connection = function (self, error) {
    debug('Retrying connection...');

    var reconnect_params = {
        delay: self.retry_delay,
        attempt: self.attempts,
        error: error
    };
    if (self.options.camel_case) {
        reconnect_params.totalRetryTime = self.retry_totaltime;
        reconnect_params.timesConnected = self.times_connected;
    } else {
        reconnect_params.total_retry_time = self.retry_totaltime;
        reconnect_params.times_connected = self.times_connected;
    }
    self.emit('reconnecting', reconnect_params);

    self.retry_totaltime += self.retry_delay;
    self.attempts += 1;
    self.retry_delay = Math.round(self.retry_delay * self.retry_backoff);
    self.create_stream();
    self.retry_timer = null;
};

RedisClient.prototype.connection_gone = function (why, error) {
    // If a retry is already in progress, just let that happen
    if (this.retry_timer) {
        return;
    }
    error = error || null;

    debug('Redis connection is gone from ' + why + ' event.');
    this.connected = false;
    this.ready = false;
    // Deactivate cork to work with the offline queue
    this.cork = noop;
    this.uncork = noop;
    this.pipeline = false;
    this.pub_sub_mode = 0;

    // since we are collapsing end and close, users don't expect to be called twice
    if (!this.emitted_end) {
        this.emit('end');
        this.emitted_end = true;
    }

    // If this is a requested shutdown, then don't retry
    if (this.closing) {
        debug('Connection ended by quit / end command, not retrying.');
        this.flush_and_error({
            message: 'Stream connection ended and command aborted.',
            code: 'NR_CLOSED'
        }, {
            error: error
        });
        return;
    }

    if (typeof this.options.retry_strategy === 'function') {
        var retry_params = {
            attempt: this.attempts,
            error: error
        };
        if (this.options.camel_case) {
            retry_params.totalRetryTime = this.retry_totaltime;
            retry_params.timesConnected = this.times_connected;
        } else {
            retry_params.total_retry_time = this.retry_totaltime;
            retry_params.times_connected = this.times_connected;
        }
        this.retry_delay = this.options.retry_strategy(retry_params);
        if (typeof this.retry_delay !== 'number') {
            // Pass individual error through
            if (this.retry_delay instanceof Error) {
                error = this.retry_delay;
            }
            this.flush_and_error({
                message: 'Stream connection ended and command aborted.',
                code: 'NR_CLOSED'
            }, {
                error: error
            });
            this.end(false);
            return;
        }
    }

    if (this.max_attempts !== 0 && this.attempts >= this.max_attempts || this.retry_totaltime >= this.connect_timeout) {
        var message = 'Redis connection in broken state: ';
        if (this.retry_totaltime >= this.connect_timeout) {
            message += 'connection timeout exceeded.';
        } else {
            message += 'maximum connection attempts exceeded.';
        }

        this.flush_and_error({
            message: message,
            code: 'CONNECTION_BROKEN',
        }, {
            error: error
        });
        var err = new Error(message);
        err.code = 'CONNECTION_BROKEN';
        if (error) {
            err.origin = error;
        }
        this.emit('error', err);
        this.end(false);
        return;
    }

    // Retry commands after a reconnect instead of throwing an error. Use this with caution
    if (this.options.retry_unfulfilled_commands) {
        this.offline_queue.unshift.apply(this.offline_queue, this.command_queue.toArray());
        this.command_queue.clear();
    } else if (this.command_queue.length !== 0) {
        this.flush_and_error({
            message: 'Redis connection lost and command aborted.',
            code: 'UNCERTAIN_STATE'
        }, {
            error: error,
            queues: ['command_queue']
        });
    }

    if (this.retry_max_delay !== null && this.retry_delay > this.retry_max_delay) {
        this.retry_delay = this.retry_max_delay;
    } else if (this.retry_totaltime + this.retry_delay > this.connect_timeout) {
        // Do not exceed the maximum
        this.retry_delay = this.connect_timeout - this.retry_totaltime;
    }

    debug('Retry connection in ' + this.retry_delay + ' ms');

    this.retry_timer = setTimeout(retry_connection, this.retry_delay, this, error);
};

RedisClient.prototype.return_error = function (err) {
    var command_obj = this.command_queue.shift();
    if (command_obj.error) {
        err.stack = command_obj.error.stack.replace(/^Error.*?\n/, 'ReplyError: ' + err.message + '\n');
    }
    err.command = command_obj.command.toUpperCase();
    if (command_obj.args && command_obj.args.length) {
        err.args = command_obj.args;
    }

    // Count down pub sub mode if in entering modus
    if (this.pub_sub_mode > 1) {
        this.pub_sub_mode--;
    }

    var match = err.message.match(utils.err_code);
    // LUA script could return user errors that don't behave like all other errors!
    if (match) {
        err.code = match[1];
    }

    utils.callback_or_emit(this, command_obj.callback, err);
};

RedisClient.prototype.drain = function () {
    this.emit('drain');
    this.should_buffer = false;
};

RedisClient.prototype.emit_idle = function () {
    if (this.command_queue.length === 0 && this.pub_sub_mode === 0) {
        this.emit('idle');
    }
};

function normal_reply (self, reply) {
    var command_obj = self.command_queue.shift();
    if (typeof command_obj.callback === 'function') {
        if (command_obj.command !== 'exec') {
            reply = self.handle_reply(reply, command_obj.command, command_obj.buffer_args);
        }
        command_obj.callback(null, reply);
    } else {
        debug('No callback for reply');
    }
}

function subscribe_unsubscribe (self, reply, type) {
    // Subscribe commands take an optional callback and also emit an event, but only the _last_ response is included in the callback
    // The pub sub commands return each argument in a separate return value and have to be handled that way
    var command_obj = self.command_queue.get(0);
    var buffer = self.options.return_buffers || self.options.detect_buffers && command_obj.buffer_args;
    var channel = (buffer || reply[1] === null) ? reply[1] : reply[1].toString();
    var count = +reply[2]; // Return the channel counter as number no matter if `string_numbers` is activated or not
    debug(type, channel);

    // Emit first, then return the callback
    if (channel !== null) { // Do not emit or "unsubscribe" something if there was no channel to unsubscribe from
        self.emit(type, channel, count);
        if (type === 'subscribe' || type === 'psubscribe') {
            self.subscription_set[type + '_' + channel] = channel;
        } else {
            type = type === 'unsubscribe' ? 'subscribe' : 'psubscribe'; // Make types consistent
            delete self.subscription_set[type + '_' + channel];
        }
    }

    if (command_obj.args.length === 1 || self.sub_commands_left === 1 || command_obj.args.length === 0 && (count === 0 || channel === null)) {
        if (count === 0) { // unsubscribed from all channels
            var running_command;
            var i = 1;
            self.pub_sub_mode = 0; // Deactivating pub sub mode
            // This should be a rare case and therefore handling it this way should be good performance wise for the general case
            while (running_command = self.command_queue.get(i)) {
                if (SUBSCRIBE_COMMANDS[running_command.command]) {
                    self.pub_sub_mode = i; // Entering pub sub mode again
                    break;
                }
                i++;
            }
        }
        self.command_queue.shift();
        if (typeof command_obj.callback === 'function') {
            // TODO: The current return value is pretty useless.
            // Evaluate to change this in v.3 to return all subscribed / unsubscribed channels in an array including the number of channels subscribed too
            command_obj.callback(null, channel);
        }
        self.sub_commands_left = 0;
    } else {
        if (self.sub_commands_left !== 0) {
            self.sub_commands_left--;
        } else {
            self.sub_commands_left = command_obj.args.length ? command_obj.args.length - 1 : count;
        }
    }
}

function return_pub_sub (self, reply) {
    var type = reply[0].toString();
    if (type === 'message') { // channel, message
        if (!self.options.return_buffers || self.message_buffers) { // backwards compatible. Refactor this in v.3 to always return a string on the normal emitter
            self.emit('message', reply[1].toString(), reply[2].toString());
            self.emit('message_buffer', reply[1], reply[2]);
            self.emit('messageBuffer', reply[1], reply[2]);
        } else {
            self.emit('message', reply[1], reply[2]);
        }
    } else if (type === 'pmessage') { // pattern, channel, message
        if (!self.options.return_buffers || self.message_buffers) { // backwards compatible. Refactor this in v.3 to always return a string on the normal emitter
            self.emit('pmessage', reply[1].toString(), reply[2].toString(), reply[3].toString());
            self.emit('pmessage_buffer', reply[1], reply[2], reply[3]);
            self.emit('pmessageBuffer', reply[1], reply[2], reply[3]);
        } else {
            self.emit('pmessage', reply[1], reply[2], reply[3]);
        }
    } else {
        subscribe_unsubscribe(self, reply, type);
    }
}

RedisClient.prototype.return_reply = function (reply) {
    // If in monitor mode, all normal commands are still working and we only want to emit the streamlined commands
    // As this is not the average use case and monitor is expensive anyway, let's change the code here, to improve
    // the average performance of all other commands in case of no monitor mode
    if (this.monitoring) {
        var replyStr;
        if (this.buffers && Buffer.isBuffer(reply)) {
            replyStr = reply.toString();
        } else {
            replyStr = reply;
        }
        // While reconnecting the redis server does not recognize the client as in monitor mode anymore
        // Therefore the monitor command has to finish before it catches further commands
        if (typeof replyStr === 'string' && utils.monitor_regex.test(replyStr)) {
            var timestamp = replyStr.slice(0, replyStr.indexOf(' '));
            var args = replyStr.slice(replyStr.indexOf('"') + 1, -1).split('" "').map(function (elem) {
                return elem.replace(/\\"/g, '"');
            });
            this.emit('monitor', timestamp, args, replyStr);
            return;
        }
    }
    if (this.pub_sub_mode === 0) {
        normal_reply(this, reply);
    } else if (this.pub_sub_mode !== 1) {
        this.pub_sub_mode--;
        normal_reply(this, reply);
    } else if (!(reply instanceof Array) || reply.length <= 2) {
        // Only PING and QUIT are allowed in this context besides the pub sub commands
        // Ping replies with ['pong', null|value] and quit with 'OK'
        normal_reply(this, reply);
    } else {
        return_pub_sub(this, reply);
    }
};

function handle_offline_command (self, command_obj) {
    var command = command_obj.command;
    var err, msg;
    if (self.closing || !self.enable_offline_queue) {
        command = command.toUpperCase();
        if (!self.closing) {
            if (self.stream.writable) {
                msg = 'The connection is not yet established and the offline queue is deactivated.';
            } else {
                msg = 'Stream not writeable.';
            }
        } else {
            msg = 'The connection is already closed.';
        }
        err = new errorClasses.AbortError({
            message: command + " can't be processed. " + msg,
            code: 'NR_CLOSED',
            command: command
        });
        if (command_obj.args.length) {
            err.args = command_obj.args;
        }
        utils.reply_in_order(self, command_obj.callback, err);
    } else {
        debug('Queueing ' + command + ' for next server connection.');
        self.offline_queue.push(command_obj);
    }
    self.should_buffer = true;
}

// Do not call internal_send_command directly, if you are not absolutly certain it handles everything properly
// e.g. monitor / info does not work with internal_send_command only
RedisClient.prototype.internal_send_command = function (command_obj) {
    var arg, prefix_keys;
    var i = 0;
    var command_str = '';
    var args = command_obj.args;
    var command = command_obj.command;
    var len = args.length;
    var big_data = false;
    var args_copy = new Array(len);

    if (process.domain && command_obj.callback) {
        command_obj.callback = process.domain.bind(command_obj.callback);
    }

    if (this.ready === false || this.stream.writable === false) {
        // Handle offline commands right away
        handle_offline_command(this, command_obj);
        return false; // Indicate buffering
    }

    for (i = 0; i < len; i += 1) {
        if (typeof args[i] === 'string') {
            // 30000 seemed to be a good value to switch to buffers after testing and checking the pros and cons
            if (args[i].length > 30000) {
                big_data = true;
                args_copy[i] = new Buffer(args[i], 'utf8');
            } else {
                args_copy[i] = args[i];
            }
        } else if (typeof args[i] === 'object') { // Checking for object instead of Buffer.isBuffer helps us finding data types that we can't handle properly
            if (args[i] instanceof Date) { // Accept dates as valid input
                args_copy[i] = args[i].toString();
            } else if (args[i] === null) {
                this.warn(
                    'Deprecated: The ' + command.toUpperCase() + ' command contains a "null" argument.\n' +
                    'This is converted to a "null" string now and will return an error from v.3.0 on.\n' +
                    'Please handle this in your code to make sure everything works as you intended it to.'
                );
                args_copy[i] = 'null'; // Backwards compatible :/
            } else if (Buffer.isBuffer(args[i])) {
                args_copy[i] = args[i];
                command_obj.buffer_args = true;
                big_data = true;
            } else {
                this.warn(
                    'Deprecated: The ' + command.toUpperCase() + ' command contains a argument of type ' + args[i].constructor.name + '.\n' +
                    'This is converted to "' + args[i].toString() + '" by using .toString() now and will return an error from v.3.0 on.\n' +
                    'Please handle this in your code to make sure everything works as you intended it to.'
                );
                args_copy[i] = args[i].toString(); // Backwards compatible :/
            }
        } else if (typeof args[i] === 'undefined') {
            this.warn(
                'Deprecated: The ' + command.toUpperCase() + ' command contains a "undefined" argument.\n' +
                'This is converted to a "undefined" string now and will return an error from v.3.0 on.\n' +
                'Please handle this in your code to make sure everything works as you intended it to.'
            );
            args_copy[i] = 'undefined'; // Backwards compatible :/
        } else {
            // Seems like numbers are converted fast using string concatenation
            args_copy[i] = '' + args[i];
        }
    }

    if (this.options.prefix) {
        prefix_keys = commands.getKeyIndexes(command, args_copy);
        for (i = prefix_keys.pop(); i !== undefined; i = prefix_keys.pop()) {
            args_copy[i] = this.options.prefix + args_copy[i];
        }
    }
    if (typeof this.options.rename_commands !== 'undefined' && this.options.rename_commands[command]) {
        command = this.options.rename_commands[command];
    }
    // Always use 'Multi bulk commands', but if passed any Buffer args, then do multiple writes, one for each arg.
    // This means that using Buffers in commands is going to be slower, so use Strings if you don't already have a Buffer.
    command_str = '*' + (len + 1) + '\r\n$' + command.length + '\r\n' + command + '\r\n';

    if (big_data === false) { // Build up a string and send entire command in one write
        for (i = 0; i < len; i += 1) {
            arg = args_copy[i];
            command_str += '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n';
        }
        debug('Send ' + this.address + ' id ' + this.connection_id + ': ' + command_str);
        this.write(command_str);
    } else {
        debug('Send command (' + command_str + ') has Buffer arguments');
        this.fire_strings = false;
        this.write(command_str);

        for (i = 0; i < len; i += 1) {
            arg = args_copy[i];
            if (typeof arg === 'string') {
                this.write('$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n');
            } else { // buffer
                this.write('$' + arg.length + '\r\n');
                this.write(arg);
                this.write('\r\n');
            }
            debug('send_command: buffer send ' + arg.length + ' bytes');
        }
    }
    if (command_obj.call_on_write) {
        command_obj.call_on_write();
    }
    // Handle `CLIENT REPLY ON|OFF|SKIP`
    // This has to be checked after call_on_write
    /* istanbul ignore else: TODO: Remove this as soon as we test Redis 3.2 on travis */
    if (this.reply === 'ON') {
        this.command_queue.push(command_obj);
    } else {
        // Do not expect a reply
        // Does this work in combination with the pub sub mode?
        if (command_obj.callback) {
            utils.reply_in_order(this, command_obj.callback, null, undefined, this.command_queue);
        }
        if (this.reply === 'SKIP') {
            this.reply = 'SKIP_ONE_MORE';
        } else if (this.reply === 'SKIP_ONE_MORE') {
            this.reply = 'ON';
        }
    }
    return !this.should_buffer;
};

RedisClient.prototype.write_strings = function () {
    var str = '';
    for (var command = this.pipeline_queue.shift(); command; command = this.pipeline_queue.shift()) {
        // Write to stream if the string is bigger than 4mb. The biggest string may be Math.pow(2, 28) - 15 chars long
        if (str.length + command.length > 4 * 1024 * 1024) {
            this.should_buffer = !this.stream.write(str);
            str = '';
        }
        str += command;
    }
    if (str !== '') {
        this.should_buffer = !this.stream.write(str);
    }
};

RedisClient.prototype.write_buffers = function () {
    for (var command = this.pipeline_queue.shift(); command; command = this.pipeline_queue.shift()) {
        this.should_buffer = !this.stream.write(command);
    }
};

RedisClient.prototype.write = function (data) {
    if (this.pipeline === false) {
        this.should_buffer = !this.stream.write(data);
        return;
    }
    this.pipeline_queue.push(data);
};

Object.defineProperty(exports, 'debugMode', {
    get: function () {
        return this.debug_mode;
    },
    set: function (val) {
        this.debug_mode = val;
    }
});

// Don't officially expose the command_queue directly but only the length as read only variable
Object.defineProperty(RedisClient.prototype, 'command_queue_length', {
    get: function () {
        return this.command_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'offline_queue_length', {
    get: function () {
        return this.offline_queue.length;
    }
});

// Add support for camelCase by adding read only properties to the client
// All known exposed snake_case variables are added here
Object.defineProperty(RedisClient.prototype, 'retryDelay', {
    get: function () {
        return this.retry_delay;
    }
});

Object.defineProperty(RedisClient.prototype, 'retryBackoff', {
    get: function () {
        return this.retry_backoff;
    }
});

Object.defineProperty(RedisClient.prototype, 'commandQueueLength', {
    get: function () {
        return this.command_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'offlineQueueLength', {
    get: function () {
        return this.offline_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'shouldBuffer', {
    get: function () {
        return this.should_buffer;
    }
});

Object.defineProperty(RedisClient.prototype, 'connectionId', {
    get: function () {
        return this.connection_id;
    }
});

Object.defineProperty(RedisClient.prototype, 'serverInfo', {
    get: function () {
        return this.server_info;
    }
});

exports.createClient = function () {
    return new RedisClient(unifyOptions.apply(null, arguments));
};
exports.RedisClient = RedisClient;
exports.print = utils.print;
exports.Multi = require('./lib/multi');
exports.AbortError = errorClasses.AbortError;
exports.ReplyError = Parser.ReplyError;
exports.AggregateError = errorClasses.AggregateError;

// Add all redis commands / node_redis api to the client
require('./lib/individualCommands');
require('./lib/extendedApi');
require('./lib/commands');

}).call(this,require('_process'),require("buffer").Buffer)
},{"./lib/command":2,"./lib/commands":3,"./lib/createClient":4,"./lib/customErrors":5,"./lib/debug":6,"./lib/extendedApi":7,"./lib/individualCommands":8,"./lib/multi":9,"./lib/utils":10,"_process":28,"buffer":22,"double-ended-queue":11,"events":26,"net":21,"redis-commands":15,"redis-parser":16,"tls":21,"util":38}],2:[function(require,module,exports){
(function (process){
'use strict';

var betterStackTraces = /development/i.test(process.env.NODE_ENV) || /\bredis\b/i.test(process.env.NODE_DEBUG);

function Command (command, args, callback, call_on_write) {
    this.command = command;
    this.args = args;
    this.buffer_args = false;
    this.callback = callback;
    this.call_on_write = call_on_write;
    if (betterStackTraces) {
        this.error = new Error();
    }
}

module.exports = Command;

}).call(this,require('_process'))
},{"_process":28}],3:[function(require,module,exports){
'use strict';

var commands = require('redis-commands');
var Multi = require('./multi');
var RedisClient = require('../').RedisClient;
var Command = require('./command');
// Feature detect if a function may change it's name
var changeFunctionName = (function () {
    var fn = function abc () {};
    try {
        Object.defineProperty(fn, 'name', {
            value: 'foobar'
        });
        return true;
    } catch (e) {
        return false;
    }
}());

// TODO: Rewrite this including the invidual commands into a Commands class
// that provided a functionality to add new commands to the client

commands.list.forEach(function (command) {

    // Some rare Redis commands use special characters in their command name
    // Convert those to a underscore to prevent using invalid function names
    var commandName = command.replace(/(?:^([0-9])|[^a-zA-Z0-9_$])/g, '_$1');

    // Do not override existing functions
    if (!RedisClient.prototype[command]) {
        RedisClient.prototype[command.toUpperCase()] = RedisClient.prototype[command] = function () {
            var arr;
            var len = arguments.length;
            var callback;
            var i = 0;
            if (Array.isArray(arguments[0])) {
                arr = arguments[0];
                if (len === 2) {
                    callback = arguments[1];
                }
            } else if (len > 1 && Array.isArray(arguments[1])) {
                if (len === 3) {
                    callback = arguments[2];
                }
                len = arguments[1].length;
                arr = new Array(len + 1);
                arr[0] = arguments[0];
                for (; i < len; i += 1) {
                    arr[i + 1] = arguments[1][i];
                }
            } else {
                // The later should not be the average use case
                if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
                    len--;
                    callback = arguments[len];
                }
                arr = new Array(len);
                for (; i < len; i += 1) {
                    arr[i] = arguments[i];
                }
            }
            return this.internal_send_command(new Command(command, arr, callback));
        };
        if (changeFunctionName) {
            Object.defineProperty(RedisClient.prototype[command], 'name', {
                value: commandName
            });
        }
    }

    // Do not override existing functions
    if (!Multi.prototype[command]) {
        Multi.prototype[command.toUpperCase()] = Multi.prototype[command] = function () {
            var arr;
            var len = arguments.length;
            var callback;
            var i = 0;
            if (Array.isArray(arguments[0])) {
                arr = arguments[0];
                if (len === 2) {
                    callback = arguments[1];
                }
            } else if (len > 1 && Array.isArray(arguments[1])) {
                if (len === 3) {
                    callback = arguments[2];
                }
                len = arguments[1].length;
                arr = new Array(len + 1);
                arr[0] = arguments[0];
                for (; i < len; i += 1) {
                    arr[i + 1] = arguments[1][i];
                }
            } else {
                // The later should not be the average use case
                if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
                    len--;
                    callback = arguments[len];
                }
                arr = new Array(len);
                for (; i < len; i += 1) {
                    arr[i] = arguments[i];
                }
            }
            this.queue.push(new Command(command, arr, callback));
            return this;
        };
        if (changeFunctionName) {
            Object.defineProperty(Multi.prototype[command], 'name', {
                value: commandName
            });
        }
    }
});

},{"../":1,"./command":2,"./multi":9,"redis-commands":15}],4:[function(require,module,exports){
'use strict';

var utils = require('./utils');
var URL = require('url');

module.exports = function createClient (port_arg, host_arg, options) {

    if (typeof port_arg === 'number' || typeof port_arg === 'string' && /^\d+$/.test(port_arg)) {

        var host;
        if (typeof host_arg === 'string') {
            host = host_arg;
        } else {
            if (options && host_arg) {
                throw new TypeError('Unknown type of connection in createClient()');
            }
            options = options || host_arg;
        }
        options = utils.clone(options);
        options.host = host || options.host;
        options.port = port_arg;

    } else if (typeof port_arg === 'string' || port_arg && port_arg.url) {

        options = utils.clone(port_arg.url ? port_arg : host_arg || options);
        var parsed = URL.parse(port_arg.url || port_arg, true, true);

        // [redis:]//[[user][:password]@][host][:port][/db-number][?db=db-number[&password=bar[&option=value]]]
        if (parsed.slashes) { // We require slashes
            if (parsed.auth) {
                options.password = parsed.auth.split(':')[1];
            }
            if (parsed.protocol && parsed.protocol !== 'redis:') {
                console.warn('node_redis: WARNING: You passed "' + parsed.protocol.substring(0, parsed.protocol.length - 1) + '" as protocol instead of the "redis" protocol!');
            }
            if (parsed.pathname && parsed.pathname !== '/') {
                options.db = parsed.pathname.substr(1);
            }
            if (parsed.hostname) {
                options.host = parsed.hostname;
            }
            if (parsed.port) {
                options.port = parsed.port;
            }
            if (parsed.search !== '') {
                var elem;
                for (elem in parsed.query) {
                    // If options are passed twice, only the parsed options will be used
                    if (elem in options) {
                        if (options[elem] === parsed.query[elem]) {
                            console.warn('node_redis: WARNING: You passed the ' + elem + ' option twice!');
                        } else {
                            throw new RangeError('The ' + elem + ' option is added twice and does not match');
                        }
                    }
                    options[elem] = parsed.query[elem];
                }
            }
        } else if (parsed.hostname) {
            throw new RangeError('The redis url must begin with slashes "//" or contain slashes after the redis protocol');
        } else {
            options.path = port_arg;
        }

    } else if (typeof port_arg === 'object' || port_arg === undefined) {
        options = utils.clone(port_arg || options);
        options.host = options.host || host_arg;

        if (port_arg && arguments.length !== 1) {
            throw new TypeError('To many arguments passed to createClient. Please only pass the options object');
        }
    }

    if (!options) {
        throw new TypeError('Unknown type of connection in createClient()');
    }

    return options;
};

},{"./utils":10,"url":34}],5:[function(require,module,exports){
'use strict';

var util = require('util');

function AbortError (obj) {
    Error.captureStackTrace(this, this.constructor);
    Object.defineProperty(this, 'message', {
        value: obj.message || '',
        configurable: true,
        writable: true
    });
    for (var keys = Object.keys(obj), key = keys.pop(); key; key = keys.pop()) {
        this[key] = obj[key];
    }
}

function AggregateError (obj) {
    Error.captureStackTrace(this, this.constructor);
    Object.defineProperty(this, 'message', {
        value: obj.message || '',
        configurable: true,
        writable: true
    });
    for (var keys = Object.keys(obj), key = keys.pop(); key; key = keys.pop()) {
        this[key] = obj[key];
    }
}

util.inherits(AbortError, Error);
util.inherits(AggregateError, AbortError);

Object.defineProperty(AbortError.prototype, 'name', {
    value: 'AbortError',
    // configurable: true,
    writable: true
});
Object.defineProperty(AggregateError.prototype, 'name', {
    value: 'AggregateError',
    // configurable: true,
    writable: true
});

module.exports = {
    AbortError: AbortError,
    AggregateError: AggregateError
};

},{"util":38}],6:[function(require,module,exports){
'use strict';

var index = require('../');

function debug () {
    if (index.debug_mode) {
        console.error.apply(null, arguments);
    }
}

module.exports = debug;

},{"../":1}],7:[function(require,module,exports){
'use strict';

var utils = require('./utils');
var debug = require('./debug');
var RedisClient = require('../').RedisClient;
var Command = require('./command');
var noop = function () {};

/**********************************************
All documented and exposed API belongs in here
**********************************************/

// Redirect calls to the appropriate function and use to send arbitrary / not supported commands
RedisClient.prototype.send_command = RedisClient.prototype.sendCommand = function (command, args, callback) {
    // Throw to fail early instead of relying in order in this case
    if (typeof command !== 'string') {
        throw new TypeError('Wrong input type "' + (command !== null && command !== undefined ? command.constructor.name : command) + '" for command name');
    }
    if (!Array.isArray(args)) {
        if (args === undefined || args === null) {
            args = [];
        } else if (typeof args === 'function' && callback === undefined) {
            callback = args;
            args = [];
        } else {
            throw new TypeError('Wrong input type "' + args.constructor.name + '" for args');
        }
    }
    if (typeof callback !== 'function' && callback !== undefined) {
        throw new TypeError('Wrong input type "' + (callback !== null ? callback.constructor.name : 'null') + '" for callback function');
    }

    // Using the raw multi command is only possible with this function
    // If the command is not yet added to the client, the internal function should be called right away
    // Otherwise we need to redirect the calls to make sure the interal functions don't get skipped
    // The internal functions could actually be used for any non hooked function
    // but this might change from time to time and at the moment there's no good way to distinguishe them
    // from each other, so let's just do it do it this way for the time being
    if (command === 'multi' || typeof this[command] !== 'function') {
        return this.internal_send_command(new Command(command, args, callback));
    }
    if (typeof callback === 'function') {
        args = args.concat([callback]); // Prevent manipulating the input array
    }
    return this[command].apply(this, args);
};

RedisClient.prototype.end = function (flush) {
    // Flush queue if wanted
    if (flush) {
        this.flush_and_error({
            message: 'Connection forcefully ended and command aborted.',
            code: 'NR_CLOSED'
        });
    } else if (arguments.length === 0) {
        this.warn(
            'Using .end() without the flush parameter is deprecated and throws from v.3.0.0 on.\n' +
            'Please check the doku (https://github.com/NodeRedis/node_redis) and explictly use flush.'
        );
    }
    // Clear retry_timer
    if (this.retry_timer) {
        clearTimeout(this.retry_timer);
        this.retry_timer = null;
    }
    this.stream.removeAllListeners();
    this.stream.on('error', noop);
    this.connected = false;
    this.ready = false;
    this.closing = true;
    return this.stream.destroySoon();
};

RedisClient.prototype.unref = function () {
    if (this.connected) {
        debug("Unref'ing the socket connection");
        this.stream.unref();
    } else {
        debug('Not connected yet, will unref later');
        this.once('connect', function () {
            this.unref();
        });
    }
};

RedisClient.prototype.duplicate = function (options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }
    var existing_options = utils.clone(this.options);
    options = utils.clone(options);
    for (var elem in options) {
        existing_options[elem] = options[elem];
    }
    var client = new RedisClient(existing_options);
    client.selected_db = this.selected_db;
    if (typeof callback === 'function') {
        var ready_listener = function () {
            callback(null, client);
            client.removeAllListeners(error_listener);
        };
        var error_listener = function (err) {
            callback(err);
            client.end(true);
        };
        client.once('ready', ready_listener);
        client.once('error', error_listener);
        return;
    }
    return client;
};

},{"../":1,"./command":2,"./debug":6,"./utils":10}],8:[function(require,module,exports){
'use strict';

var utils = require('./utils');
var debug = require('./debug');
var Multi = require('./multi');
var Command = require('./command');
var no_password_is_set = /no password is set/;
var loading = /LOADING/;
var RedisClient = require('../').RedisClient;

/********************************************************************************************
 Replace built-in redis functions

 The callback may be hooked as needed. The same does not apply to the rest of the function.
 State should not be set outside of the callback if not absolutly necessary.
 This is important to make sure it works the same as single command or in a multi context.
 To make sure everything works with the offline queue use the "call_on_write" function.
 This is going to be executed while writing to the stream.

 TODO: Implement individal command generation as soon as possible to prevent divergent code
 on single and multi calls!
********************************************************************************************/

RedisClient.prototype.multi = RedisClient.prototype.MULTI = function multi (args) {
    var multi = new Multi(this, args);
    multi.exec = multi.EXEC = multi.exec_transaction;
    return multi;
};

// ATTENTION: This is not a native function but is still handled as a individual command as it behaves just the same as multi
RedisClient.prototype.batch = RedisClient.prototype.BATCH = function batch (args) {
    return new Multi(this, args);
};

function select_callback (self, db, callback) {
    return function (err, res) {
        if (err === null) {
            // Store db in this.select_db to restore it on reconnect
            self.selected_db = db;
        }
        utils.callback_or_emit(self, callback, err, res);
    };
}

RedisClient.prototype.select = RedisClient.prototype.SELECT = function select (db, callback) {
    return this.internal_send_command(new Command('select', [db], select_callback(this, db, callback)));
};

Multi.prototype.select = Multi.prototype.SELECT = function select (db, callback) {
    this.queue.push(new Command('select', [db], select_callback(this._client, db, callback)));
    return this;
};

RedisClient.prototype.monitor = RedisClient.prototype.MONITOR = function monitor (callback) {
    // Use a individual command, as this is a special case that does not has to be checked for any other command
    var self = this;
    var call_on_write = function () {
        // Activating monitor mode has to happen before Redis returned the callback. The monitor result is returned first.
        // Therefore we expect the command to be properly processed. If this is not the case, it's not an issue either.
        self.monitoring = true;
    };
    return this.internal_send_command(new Command('monitor', [], callback, call_on_write));
};

// Only works with batch, not in a transaction
Multi.prototype.monitor = Multi.prototype.MONITOR = function monitor (callback) {
    // Use a individual command, as this is a special case that does not has to be checked for any other command
    if (this.exec !== this.exec_transaction) {
        var self = this;
        var call_on_write = function () {
            self._client.monitoring = true;
        };
        this.queue.push(new Command('monitor', [], callback, call_on_write));
        return this;
    }
    // Set multi monitoring to indicate the exec that it should abort
    // Remove this "hack" as soon as Redis might fix this
    this.monitoring = true;
    return this;
};

function quit_callback (self, callback) {
    return function (err, res) {
        if (err && err.code === 'NR_CLOSED') {
            // Pretent the quit command worked properly in this case.
            // Either the quit landed in the offline queue and was flushed at the reconnect
            // or the offline queue is deactivated and the command was rejected right away
            // or the stream is not writable
            // or while sending the quit, the connection ended / closed
            err = null;
            res = 'OK';
        }
        utils.callback_or_emit(self, callback, err, res);
        if (self.stream.writable) {
            // If the socket is still alive, kill it. This could happen if quit got a NR_CLOSED error code
            self.stream.destroy();
        }
    };
}

RedisClient.prototype.QUIT = RedisClient.prototype.quit = function quit (callback) {
    // TODO: Consider this for v.3
    // Allow the quit command to be fired as soon as possible to prevent it landing in the offline queue.
    // this.ready = this.offline_queue.length === 0;
    var backpressure_indicator = this.internal_send_command(new Command('quit', [], quit_callback(this, callback)));
    // Calling quit should always end the connection, no matter if there's a connection or not
    this.closing = true;
    this.ready = false;
    return backpressure_indicator;
};

// Only works with batch, not in a transaction
Multi.prototype.QUIT = Multi.prototype.quit = function quit (callback) {
    var self = this._client;
    var call_on_write = function () {
        // If called in a multi context, we expect redis is available
        self.closing = true;
        self.ready = false;
    };
    this.queue.push(new Command('quit', [], quit_callback(self, callback), call_on_write));
    return this;
};

function info_callback (self, callback) {
    return function (err, res) {
        if (res) {
            var obj = {};
            var lines = res.toString().split('\r\n');
            var line, parts, sub_parts;

            for (var i = 0; i < lines.length; i++) {
                parts = lines[i].split(':');
                if (parts[1]) {
                    if (parts[0].indexOf('db') === 0) {
                        sub_parts = parts[1].split(',');
                        obj[parts[0]] = {};
                        while (line = sub_parts.pop()) {
                            line = line.split('=');
                            obj[parts[0]][line[0]] = +line[1];
                        }
                    } else {
                        obj[parts[0]] = parts[1];
                    }
                }
            }
            obj.versions = [];
            if (obj.redis_version) {
                obj.redis_version.split('.').forEach(function (num) {
                    obj.versions.push(+num);
                });
            }
            // Expose info key/vals to users
            self.server_info = obj;
        } else {
            self.server_info = {};
        }
        utils.callback_or_emit(self, callback, err, res);
    };
}

// Store info in this.server_info after each call
RedisClient.prototype.info = RedisClient.prototype.INFO = function info (section, callback) {
    var args = [];
    if (typeof section === 'function') {
        callback = section;
    } else if (section !== undefined) {
        args = Array.isArray(section) ? section : [section];
    }
    return this.internal_send_command(new Command('info', args, info_callback(this, callback)));
};

Multi.prototype.info = Multi.prototype.INFO = function info (section, callback) {
    var args = [];
    if (typeof section === 'function') {
        callback = section;
    } else if (section !== undefined) {
        args = Array.isArray(section) ? section : [section];
    }
    this.queue.push(new Command('info', args, info_callback(this._client, callback)));
    return this;
};

function auth_callback (self, pass, callback) {
    return function (err, res) {
        if (err) {
            if (no_password_is_set.test(err.message)) {
                self.warn('Warning: Redis server does not require a password, but a password was supplied.');
                err = null;
                res = 'OK';
            } else if (loading.test(err.message)) {
                // If redis is still loading the db, it will not authenticate and everything else will fail
                debug('Redis still loading, trying to authenticate later');
                setTimeout(function () {
                    self.auth(pass, callback);
                }, 100);
                return;
            }
        }
        utils.callback_or_emit(self, callback, err, res);
    };
}

RedisClient.prototype.auth = RedisClient.prototype.AUTH = function auth (pass, callback) {
    debug('Sending auth to ' + this.address + ' id ' + this.connection_id);

    // Stash auth for connect and reconnect.
    this.auth_pass = pass;
    var ready = this.ready;
    this.ready = ready || this.offline_queue.length === 0;
    var tmp = this.internal_send_command(new Command('auth', [pass], auth_callback(this, pass, callback)));
    this.ready = ready;
    return tmp;
};

// Only works with batch, not in a transaction
Multi.prototype.auth = Multi.prototype.AUTH = function auth (pass, callback) {
    debug('Sending auth to ' + this.address + ' id ' + this.connection_id);

    // Stash auth for connect and reconnect.
    this.auth_pass = pass;
    this.queue.push(new Command('auth', [pass], auth_callback(this._client, callback)));
    return this;
};

RedisClient.prototype.client = RedisClient.prototype.CLIENT = function client () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else if (Array.isArray(arguments[1])) {
        if (len === 3) {
            callback = arguments[2];
        }
        len = arguments[1].length;
        arr = new Array(len + 1);
        arr[0] = arguments[0];
        for (; i < len; i += 1) {
            arr[i + 1] = arguments[1][i];
        }
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this;
    var call_on_write = undefined;
    // CLIENT REPLY ON|OFF|SKIP
    /* istanbul ignore next: TODO: Remove this as soon as Travis runs Redis 3.2 */
    if (arr.length === 2 && arr[0].toString().toUpperCase() === 'REPLY') {
        var reply_on_off = arr[1].toString().toUpperCase();
        if (reply_on_off === 'ON' || reply_on_off === 'OFF' || reply_on_off === 'SKIP') {
            call_on_write = function () {
                self.reply = reply_on_off;
            };
        }
    }
    return this.internal_send_command(new Command('client', arr, callback, call_on_write));
};

Multi.prototype.client = Multi.prototype.CLIENT = function client () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else if (Array.isArray(arguments[1])) {
        if (len === 3) {
            callback = arguments[2];
        }
        len = arguments[1].length;
        arr = new Array(len + 1);
        arr[0] = arguments[0];
        for (; i < len; i += 1) {
            arr[i + 1] = arguments[1][i];
        }
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this._client;
    var call_on_write = undefined;
    // CLIENT REPLY ON|OFF|SKIP
    /* istanbul ignore next: TODO: Remove this as soon as Travis runs Redis 3.2 */
    if (arr.length === 2 && arr[0].toString().toUpperCase() === 'REPLY') {
        var reply_on_off = arr[1].toString().toUpperCase();
        if (reply_on_off === 'ON' || reply_on_off === 'OFF' || reply_on_off === 'SKIP') {
            call_on_write = function () {
                self.reply = reply_on_off;
            };
        }
    }
    this.queue.push(new Command('client', arr, callback, call_on_write));
    return this;
};

RedisClient.prototype.hmset = RedisClient.prototype.HMSET = function hmset () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else if (Array.isArray(arguments[1])) {
        if (len === 3) {
            callback = arguments[2];
        }
        len = arguments[1].length;
        arr = new Array(len + 1);
        arr[0] = arguments[0];
        for (; i < len; i += 1) {
            arr[i + 1] = arguments[1][i];
        }
    } else if (typeof arguments[1] === 'object' && (arguments.length === 2 || arguments.length === 3 && (typeof arguments[2] === 'function' || typeof arguments[2] === 'undefined'))) {
        arr = [arguments[0]];
        for (var field in arguments[1]) {
            arr.push(field, arguments[1][field]);
        }
        callback = arguments[2];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    return this.internal_send_command(new Command('hmset', arr, callback));
};

Multi.prototype.hmset = Multi.prototype.HMSET = function hmset () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else if (Array.isArray(arguments[1])) {
        if (len === 3) {
            callback = arguments[2];
        }
        len = arguments[1].length;
        arr = new Array(len + 1);
        arr[0] = arguments[0];
        for (; i < len; i += 1) {
            arr[i + 1] = arguments[1][i];
        }
    } else if (typeof arguments[1] === 'object' && (arguments.length === 2 || arguments.length === 3 && (typeof arguments[2] === 'function' || typeof arguments[2] === 'undefined'))) {
        arr = [arguments[0]];
        for (var field in arguments[1]) {
            arr.push(field, arguments[1][field]);
        }
        callback = arguments[2];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    this.queue.push(new Command('hmset', arr, callback));
    return this;
};

RedisClient.prototype.subscribe = RedisClient.prototype.SUBSCRIBE = function subscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this;
    var call_on_write = function () {
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    return this.internal_send_command(new Command('subscribe', arr, callback, call_on_write));
};

Multi.prototype.subscribe = Multi.prototype.SUBSCRIBE = function subscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this._client;
    var call_on_write = function () {
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    this.queue.push(new Command('subscribe', arr, callback, call_on_write));
    return this;
};

RedisClient.prototype.unsubscribe = RedisClient.prototype.UNSUBSCRIBE = function unsubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this;
    var call_on_write = function () {
        // Pub sub has to be activated even if not in pub sub mode, as the return value is manipulated in the callback
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    return this.internal_send_command(new Command('unsubscribe', arr, callback, call_on_write));
};

Multi.prototype.unsubscribe = Multi.prototype.UNSUBSCRIBE = function unsubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this._client;
    var call_on_write = function () {
        // Pub sub has to be activated even if not in pub sub mode, as the return value is manipulated in the callback
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    this.queue.push(new Command('unsubscribe', arr, callback, call_on_write));
    return this;
};

RedisClient.prototype.psubscribe = RedisClient.prototype.PSUBSCRIBE = function psubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this;
    var call_on_write = function () {
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    return this.internal_send_command(new Command('psubscribe', arr, callback, call_on_write));
};

Multi.prototype.psubscribe = Multi.prototype.PSUBSCRIBE = function psubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this._client;
    var call_on_write = function () {
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    this.queue.push(new Command('psubscribe', arr, callback, call_on_write));
    return this;
};

RedisClient.prototype.punsubscribe = RedisClient.prototype.PUNSUBSCRIBE = function punsubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this;
    var call_on_write = function () {
        // Pub sub has to be activated even if not in pub sub mode, as the return value is manipulated in the callback
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    return this.internal_send_command(new Command('punsubscribe', arr, callback, call_on_write));
};

Multi.prototype.punsubscribe = Multi.prototype.PUNSUBSCRIBE = function punsubscribe () {
    var arr,
        len = arguments.length,
        callback,
        i = 0;
    if (Array.isArray(arguments[0])) {
        arr = arguments[0];
        callback = arguments[1];
    } else {
        len = arguments.length;
        // The later should not be the average use case
        if (len !== 0 && (typeof arguments[len - 1] === 'function' || typeof arguments[len - 1] === 'undefined')) {
            len--;
            callback = arguments[len];
        }
        arr = new Array(len);
        for (; i < len; i += 1) {
            arr[i] = arguments[i];
        }
    }
    var self = this._client;
    var call_on_write = function () {
        // Pub sub has to be activated even if not in pub sub mode, as the return value is manipulated in the callback
        self.pub_sub_mode = self.pub_sub_mode || self.command_queue.length + 1;
    };
    this.queue.push(new Command('punsubscribe', arr, callback, call_on_write));
    return this;
};

},{"../":1,"./command":2,"./debug":6,"./multi":9,"./utils":10}],9:[function(require,module,exports){
'use strict';

var Queue = require('double-ended-queue');
var utils = require('./utils');
var Command = require('./command');

function Multi (client, args) {
    this._client = client;
    this.queue = new Queue();
    var command, tmp_args;
    if (args) { // Either undefined or an array. Fail hard if it's not an array
        for (var i = 0; i < args.length; i++) {
            command = args[i][0];
            tmp_args = args[i].slice(1);
            if (Array.isArray(command)) {
                this[command[0]].apply(this, command.slice(1).concat(tmp_args));
            } else {
                this[command].apply(this, tmp_args);
            }
        }
    }
}

function pipeline_transaction_command (self, command_obj, index) {
    // Queueing is done first, then the commands are executed
    var tmp = command_obj.callback;
    command_obj.callback = function (err, reply) {
        // Ignore the multi command. This is applied by node_redis and the user does not benefit by it
        if (err && index !== -1) {
            if (tmp) {
                tmp(err);
            }
            err.position = index;
            self.errors.push(err);
        }
        // Keep track of who wants buffer responses:
        // By the time the callback is called the command_obj got the buffer_args attribute attached
        self.wants_buffers[index] = command_obj.buffer_args;
        command_obj.callback = tmp;
    };
    self._client.internal_send_command(command_obj);
}

Multi.prototype.exec_atomic = Multi.prototype.EXEC_ATOMIC = Multi.prototype.execAtomic = function exec_atomic (callback) {
    if (this.queue.length < 2) {
        return this.exec_batch(callback);
    }
    return this.exec(callback);
};

function multi_callback (self, err, replies) {
    var i = 0, command_obj;

    if (err) {
        err.errors = self.errors;
        if (self.callback) {
            self.callback(err);
            // Exclude connection errors so that those errors won't be emitted twice
        } else if (err.code !== 'CONNECTION_BROKEN') {
            self._client.emit('error', err);
        }
        return;
    }

    if (replies) {
        while (command_obj = self.queue.shift()) {
            if (replies[i] instanceof Error) {
                var match = replies[i].message.match(utils.err_code);
                // LUA script could return user errors that don't behave like all other errors!
                if (match) {
                    replies[i].code = match[1];
                }
                replies[i].command = command_obj.command.toUpperCase();
                if (typeof command_obj.callback === 'function') {
                    command_obj.callback(replies[i]);
                }
            } else {
                // If we asked for strings, even in detect_buffers mode, then return strings:
                replies[i] = self._client.handle_reply(replies[i], command_obj.command, self.wants_buffers[i]);
                if (typeof command_obj.callback === 'function') {
                    command_obj.callback(null, replies[i]);
                }
            }
            i++;
        }
    }

    if (self.callback) {
        self.callback(null, replies);
    }
}

Multi.prototype.exec_transaction = function exec_transaction (callback) {
    if (this.monitoring || this._client.monitoring) {
        var err = new RangeError(
            'Using transaction with a client that is in monitor mode does not work due to faulty return values of Redis.'
        );
        err.command = 'EXEC';
        err.code = 'EXECABORT';
        return utils.reply_in_order(this._client, callback, err);
    }
    var self = this;
    var len = self.queue.length;
    self.errors = [];
    self.callback = callback;
    self._client.cork();
    self.wants_buffers = new Array(len);
    pipeline_transaction_command(self, new Command('multi', []), -1);
    // Drain queue, callback will catch 'QUEUED' or error
    for (var index = 0; index < len; index++) {
        // The commands may not be shifted off, since they are needed in the result handler
        pipeline_transaction_command(self, self.queue.get(index), index);
    }

    self._client.internal_send_command(new Command('exec', [], function (err, replies) {
        multi_callback(self, err, replies);
    }));
    self._client.uncork();
    return !self._client.should_buffer;
};

function batch_callback (self, cb, i) {
    return function batch_callback (err, res) {
        if (err) {
            self.results[i] = err;
            // Add the position to the error
            self.results[i].position = i;
        } else {
            self.results[i] = res;
        }
        cb(err, res);
    };
}

Multi.prototype.exec = Multi.prototype.EXEC = Multi.prototype.exec_batch = function exec_batch (callback) {
    var self = this;
    var len = self.queue.length;
    var index = 0;
    var command_obj;
    if (len === 0) {
        utils.reply_in_order(self._client, callback, null, []);
        return !self._client.should_buffer;
    }
    self._client.cork();
    if (!callback) {
        while (command_obj = self.queue.shift()) {
            self._client.internal_send_command(command_obj);
        }
        self._client.uncork();
        return !self._client.should_buffer;
    }
    var callback_without_own_cb = function (err, res) {
        if (err) {
            self.results.push(err);
            // Add the position to the error
            var i = self.results.length - 1;
            self.results[i].position = i;
        } else {
            self.results.push(res);
        }
        // Do not emit an error here. Otherwise each error would result in one emit.
        // The errors will be returned in the result anyway
    };
    var last_callback = function (cb) {
        return function (err, res) {
            cb(err, res);
            callback(null, self.results);
        };
    };
    self.results = [];
    while (command_obj = self.queue.shift()) {
        if (typeof command_obj.callback === 'function') {
            command_obj.callback = batch_callback(self, command_obj.callback, index);
        } else {
            command_obj.callback = callback_without_own_cb;
        }
        if (typeof callback === 'function' && index === len - 1) {
            command_obj.callback = last_callback(command_obj.callback);
        }
        this._client.internal_send_command(command_obj);
        index++;
    }
    self._client.uncork();
    return !self._client.should_buffer;
};

module.exports = Multi;

},{"./command":2,"./utils":10,"double-ended-queue":11}],10:[function(require,module,exports){
(function (process,Buffer){
'use strict';

// hgetall converts its replies to an Object. If the reply is empty, null is returned.
// These function are only called with internal data and have therefore always the same instanceof X
function replyToObject (reply) {
    // The reply might be a string or a buffer if this is called in a transaction (multi)
    if (reply.length === 0 || !(reply instanceof Array)) {
        return null;
    }
    var obj = {};
    for (var i = 0; i < reply.length; i += 2) {
        obj[reply[i].toString('binary')] = reply[i + 1];
    }
    return obj;
}

function replyToStrings (reply) {
    if (reply instanceof Buffer) {
        return reply.toString();
    }
    if (reply instanceof Array) {
        var res = new Array(reply.length);
        for (var i = 0; i < reply.length; i++) {
            // Recusivly call the function as slowlog returns deep nested replies
            res[i] = replyToStrings(reply[i]);
        }
        return res;
    }

    return reply;
}

function print (err, reply) {
    if (err) {
        // A error always begins with Error:
        console.log(err.toString());
    } else {
        console.log('Reply: ' + reply);
    }
}

var camelCase;
// Deep clone arbitrary objects with arrays. Can't handle cyclic structures (results in a range error)
// Any attribute with a non primitive value besides object and array will be passed by reference (e.g. Buffers, Maps, Functions)
// All capital letters are going to be replaced with a lower case letter and a underscore infront of it
function clone (obj) {
    var copy;
    if (Array.isArray(obj)) {
        copy = new Array(obj.length);
        for (var i = 0; i < obj.length; i++) {
            copy[i] = clone(obj[i]);
        }
        return copy;
    }
    if (Object.prototype.toString.call(obj) === '[object Object]') {
        copy = {};
        var elems = Object.keys(obj);
        var elem;
        while (elem = elems.pop()) {
            if (elem === 'tls') { // special handle tls
                copy[elem] = obj[elem];
                continue;
            }
            // Accept camelCase options and convert them to snake_case
            var snake_case = elem.replace(/[A-Z][^A-Z]/g, '_$&').toLowerCase();
            // If camelCase is detected, pass it to the client, so all variables are going to be camelCased
            // There are no deep nested options objects yet, but let's handle this future proof
            if (snake_case !== elem.toLowerCase()) {
                camelCase = true;
            }
            copy[snake_case] = clone(obj[elem]);
        }
        return copy;
    }
    return obj;
}

function convenienceClone (obj) {
    camelCase = false;
    obj = clone(obj) || {};
    if (camelCase) {
        obj.camel_case = true;
    }
    return obj;
}

function callbackOrEmit (self, callback, err, res) {
    if (callback) {
        callback(err, res);
    } else if (err) {
        self.emit('error', err);
    }
}

function replyInOrder (self, callback, err, res, queue) {
    // If the queue is explicitly passed, use that, otherwise fall back to the offline queue first,
    // as there might be commands in both queues at the same time
    var command_obj;
    /* istanbul ignore if: TODO: Remove this as soon as we test Redis 3.2 on travis */
    if (queue) {
        command_obj = queue.peekBack();
    } else {
        command_obj = self.offline_queue.peekBack() || self.command_queue.peekBack();
    }
    if (!command_obj) {
        process.nextTick(function () {
            callbackOrEmit(self, callback, err, res);
        });
    } else {
        var tmp = command_obj.callback;
        command_obj.callback = tmp ?
            function (e, r) {
                tmp(e, r);
                callbackOrEmit(self, callback, err, res);
            } :
            function (e, r) {
                if (e) {
                    self.emit('error', e);
                }
                callbackOrEmit(self, callback, err, res);
            };
    }
}

module.exports = {
    reply_to_strings: replyToStrings,
    reply_to_object: replyToObject,
    print: print,
    err_code: /^([A-Z]+)\s+(.+)$/,
    monitor_regex: /^[0-9]{10,11}\.[0-9]+ \[[0-9]{1,3} [0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{1,5}\].*/,
    clone: convenienceClone,
    callback_or_emit: callbackOrEmit,
    reply_in_order: replyInOrder
};

}).call(this,require('_process'),require("buffer").Buffer)
},{"_process":28,"buffer":22}],11:[function(require,module,exports){
/**
 * Copyright (c) 2013 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
"use strict";
function Deque(capacity) {
    this._capacity = getCapacity(capacity);
    this._length = 0;
    this._front = 0;
    if (isArray(capacity)) {
        var len = capacity.length;
        for (var i = 0; i < len; ++i) {
            this[i] = capacity[i];
        }
        this._length = len;
    }
}

Deque.prototype.toArray = function Deque$toArray() {
    var len = this._length;
    var ret = new Array(len);
    var front = this._front;
    var capacity = this._capacity;
    for (var j = 0; j < len; ++j) {
        ret[j] = this[(front + j) & (capacity - 1)];
    }
    return ret;
};

Deque.prototype.push = function Deque$push(item) {
    var argsLength = arguments.length;
    var length = this._length;
    if (argsLength > 1) {
        var capacity = this._capacity;
        if (length + argsLength > capacity) {
            for (var i = 0; i < argsLength; ++i) {
                this._checkCapacity(length + 1);
                var j = (this._front + length) & (this._capacity - 1);
                this[j] = arguments[i];
                length++;
                this._length = length;
            }
            return length;
        }
        else {
            var j = this._front;
            for (var i = 0; i < argsLength; ++i) {
                this[(j + length) & (capacity - 1)] = arguments[i];
                j++;
            }
            this._length = length + argsLength;
            return length + argsLength;
        }

    }

    if (argsLength === 0) return length;

    this._checkCapacity(length + 1);
    var i = (this._front + length) & (this._capacity - 1);
    this[i] = item;
    this._length = length + 1;
    return length + 1;
};

Deque.prototype.pop = function Deque$pop() {
    var length = this._length;
    if (length === 0) {
        return void 0;
    }
    var i = (this._front + length - 1) & (this._capacity - 1);
    var ret = this[i];
    this[i] = void 0;
    this._length = length - 1;
    return ret;
};

Deque.prototype.shift = function Deque$shift() {
    var length = this._length;
    if (length === 0) {
        return void 0;
    }
    var front = this._front;
    var ret = this[front];
    this[front] = void 0;
    this._front = (front + 1) & (this._capacity - 1);
    this._length = length - 1;
    return ret;
};

Deque.prototype.unshift = function Deque$unshift(item) {
    var length = this._length;
    var argsLength = arguments.length;


    if (argsLength > 1) {
        var capacity = this._capacity;
        if (length + argsLength > capacity) {
            for (var i = argsLength - 1; i >= 0; i--) {
                this._checkCapacity(length + 1);
                var capacity = this._capacity;
                var j = (((( this._front - 1 ) &
                    ( capacity - 1) ) ^ capacity ) - capacity );
                this[j] = arguments[i];
                length++;
                this._length = length;
                this._front = j;
            }
            return length;
        }
        else {
            var front = this._front;
            for (var i = argsLength - 1; i >= 0; i--) {
                var j = (((( front - 1 ) &
                    ( capacity - 1) ) ^ capacity ) - capacity );
                this[j] = arguments[i];
                front = j;
            }
            this._front = front;
            this._length = length + argsLength;
            return length + argsLength;
        }
    }

    if (argsLength === 0) return length;

    this._checkCapacity(length + 1);
    var capacity = this._capacity;
    var i = (((( this._front - 1 ) &
        ( capacity - 1) ) ^ capacity ) - capacity );
    this[i] = item;
    this._length = length + 1;
    this._front = i;
    return length + 1;
};

Deque.prototype.peekBack = function Deque$peekBack() {
    var length = this._length;
    if (length === 0) {
        return void 0;
    }
    var index = (this._front + length - 1) & (this._capacity - 1);
    return this[index];
};

Deque.prototype.peekFront = function Deque$peekFront() {
    if (this._length === 0) {
        return void 0;
    }
    return this[this._front];
};

Deque.prototype.get = function Deque$get(index) {
    var i = index;
    if ((i !== (i | 0))) {
        return void 0;
    }
    var len = this._length;
    if (i < 0) {
        i = i + len;
    }
    if (i < 0 || i >= len) {
        return void 0;
    }
    return this[(this._front + i) & (this._capacity - 1)];
};

Deque.prototype.isEmpty = function Deque$isEmpty() {
    return this._length === 0;
};

Deque.prototype.clear = function Deque$clear() {
    var len = this._length;
    var front = this._front;
    var capacity = this._capacity;
    for (var j = 0; j < len; ++j) {
        this[(front + j) & (capacity - 1)] = void 0;
    }
    this._length = 0;
    this._front = 0;
};

Deque.prototype.toString = function Deque$toString() {
    return this.toArray().toString();
};

Deque.prototype.valueOf = Deque.prototype.toString;
Deque.prototype.removeFront = Deque.prototype.shift;
Deque.prototype.removeBack = Deque.prototype.pop;
Deque.prototype.insertFront = Deque.prototype.unshift;
Deque.prototype.insertBack = Deque.prototype.push;
Deque.prototype.enqueue = Deque.prototype.push;
Deque.prototype.dequeue = Deque.prototype.shift;
Deque.prototype.toJSON = Deque.prototype.toArray;

Object.defineProperty(Deque.prototype, "length", {
    get: function() {
        return this._length;
    },
    set: function() {
        throw new RangeError("");
    }
});

Deque.prototype._checkCapacity = function Deque$_checkCapacity(size) {
    if (this._capacity < size) {
        this._resizeTo(getCapacity(this._capacity * 1.5 + 16));
    }
};

Deque.prototype._resizeTo = function Deque$_resizeTo(capacity) {
    var oldCapacity = this._capacity;
    this._capacity = capacity;
    var front = this._front;
    var length = this._length;
    if (front + length > oldCapacity) {
        var moveItemsCount = (front + length) & (oldCapacity - 1);
        arrayMove(this, 0, this, oldCapacity, moveItemsCount);
    }
};


var isArray = Array.isArray;

function arrayMove(src, srcIndex, dst, dstIndex, len) {
    for (var j = 0; j < len; ++j) {
        dst[j + dstIndex] = src[j + srcIndex];
        src[j + srcIndex] = void 0;
    }
}

function pow2AtLeast(n) {
    n = n >>> 0;
    n = n - 1;
    n = n | (n >> 1);
    n = n | (n >> 2);
    n = n | (n >> 4);
    n = n | (n >> 8);
    n = n | (n >> 16);
    return n + 1;
}

function getCapacity(capacity) {
    if (typeof capacity !== "number") {
        if (isArray(capacity)) {
            capacity = capacity.length;
        }
        else {
            return 16;
        }
    }
    return pow2AtLeast(
        Math.min(
            Math.max(16, capacity), 1073741824)
    );
}

module.exports = Deque;

},{}],12:[function(require,module,exports){
(function (Buffer){
var net = require("net"),
    hiredis = require('bindings')('hiredis.node');

var bufStar = new Buffer("*", "ascii");
var bufDollar = new Buffer("$", "ascii");
var bufCrlf = new Buffer("\r\n", "ascii");

exports.Reader = hiredis.Reader;

exports.writeCommand = function() {
    var args = arguments,
        bufLen = new Buffer(String(args.length), "ascii"),
        parts = [bufStar, bufLen, bufCrlf],
        size = 3 + bufLen.length;

    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        if (!Buffer.isBuffer(arg))
            arg = new Buffer(String(arg));

        bufLen = new Buffer(String(arg.length), "ascii");
        parts = parts.concat([
            bufDollar, bufLen, bufCrlf,
            arg, bufCrlf
        ]);
        size += 5 + bufLen.length + arg.length;
    }

    return Buffer.concat(parts, size);
}

exports.createConnection = function(port, host) {
    var s = net.createConnection(port || 6379, host);
    var r = new hiredis.Reader();
    var _write = s.write;

    s.write = function() {
        var data = exports.writeCommand.apply(this, arguments);
        return _write.call(s, data);
    }

    s.on("data", function(data) {
        var reply;
        r.feed(data);
        try {
            while((reply = r.get()) !== undefined)
                s.emit("reply", reply);
        } catch(err) {
            r = null;
            s.emit("error", err);
            s.destroy();
        }
    });

    return s;
}


}).call(this,require("buffer").Buffer)
},{"bindings":13,"buffer":22,"net":21}],13:[function(require,module,exports){
(function (process,__filename){

/**
 * Module dependencies.
 */

var fs = require('fs')
  , path = require('path')
  , join = path.join
  , dirname = path.dirname
  , exists = fs.existsSync || path.existsSync
  , defaults = {
        arrow: process.env.NODE_BINDINGS_ARROW || ' → '
      , compiled: process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled'
      , platform: process.platform
      , arch: process.arch
      , version: process.versions.node
      , bindings: 'bindings.node'
      , try: [
          // node-gyp's linked version in the "build" dir
          [ 'module_root', 'build', 'bindings' ]
          // node-waf and gyp_addon (a.k.a node-gyp)
        , [ 'module_root', 'build', 'Debug', 'bindings' ]
        , [ 'module_root', 'build', 'Release', 'bindings' ]
          // Debug files, for development (legacy behavior, remove for node v0.9)
        , [ 'module_root', 'out', 'Debug', 'bindings' ]
        , [ 'module_root', 'Debug', 'bindings' ]
          // Release files, but manually compiled (legacy behavior, remove for node v0.9)
        , [ 'module_root', 'out', 'Release', 'bindings' ]
        , [ 'module_root', 'Release', 'bindings' ]
          // Legacy from node-waf, node <= 0.4.x
        , [ 'module_root', 'build', 'default', 'bindings' ]
          // Production "Release" buildtype binary (meh...)
        , [ 'module_root', 'compiled', 'version', 'platform', 'arch', 'bindings' ]
        ]
    }

/**
 * The main `bindings()` function loads the compiled bindings for a given module.
 * It uses V8's Error API to determine the parent filename that this function is
 * being invoked from, which is then used to find the root directory.
 */

function bindings (opts) {

  // Argument surgery
  if (typeof opts == 'string') {
    opts = { bindings: opts }
  } else if (!opts) {
    opts = {}
  }
  opts.__proto__ = defaults

  // Get the module root
  if (!opts.module_root) {
    opts.module_root = exports.getRoot(exports.getFileName())
  }

  // Ensure the given bindings name ends with .node
  if (path.extname(opts.bindings) != '.node') {
    opts.bindings += '.node'
  }

  var tries = []
    , i = 0
    , l = opts.try.length
    , n
    , b
    , err

  for (; i<l; i++) {
    n = join.apply(null, opts.try[i].map(function (p) {
      return opts[p] || p
    }))
    tries.push(n)
    try {
      b = opts.path ? require.resolve(n) : require(n)
      if (!opts.path) {
        b.path = n
      }
      return b
    } catch (e) {
      if (!/not find/i.test(e.message)) {
        throw e
      }
    }
  }

  err = new Error('Could not locate the bindings file. Tried:\n'
    + tries.map(function (a) { return opts.arrow + a }).join('\n'))
  err.tries = tries
  throw err
}
module.exports = exports = bindings


/**
 * Gets the filename of the JavaScript file that invokes this function.
 * Used to help find the root directory of a module.
 * Optionally accepts an filename argument to skip when searching for the invoking filename
 */

exports.getFileName = function getFileName (calling_file) {
  var origPST = Error.prepareStackTrace
    , origSTL = Error.stackTraceLimit
    , dummy = {}
    , fileName

  Error.stackTraceLimit = 10

  Error.prepareStackTrace = function (e, st) {
    for (var i=0, l=st.length; i<l; i++) {
      fileName = st[i].getFileName()
      if (fileName !== __filename) {
        if (calling_file) {
            if (fileName !== calling_file) {
              return
            }
        } else {
          return
        }
      }
    }
  }

  // run the 'prepareStackTrace' function above
  Error.captureStackTrace(dummy)
  dummy.stack

  // cleanup
  Error.prepareStackTrace = origPST
  Error.stackTraceLimit = origSTL

  return fileName
}

/**
 * Gets the root directory of a module, given an arbitrary filename
 * somewhere in the module tree. The "root directory" is the directory
 * containing the `package.json` file.
 *
 *   In:  /home/nate/node-native-module/lib/index.js
 *   Out: /home/nate/node-native-module
 */

exports.getRoot = function getRoot (file) {
  var dir = dirname(file)
    , prev
  while (true) {
    if (dir === '.') {
      // Avoids an infinite loop in rare cases, like the REPL
      dir = process.cwd()
    }
    if (exists(join(dir, 'package.json')) || exists(join(dir, 'node_modules'))) {
      // Found the 'package.json' file or 'node_modules' dir; we're done
      return dir
    }
    if (prev === dir) {
      // Got to the top
      throw new Error('Could not find module root given file: "' + file
                    + '". Do you have a `package.json` file? ')
    }
    // Try the parent dir next
    prev = dir
    dir = join(dir, '..')
  }
}

}).call(this,require('_process'),"/../../node_modules/redis/node_modules/hiredis/node_modules/bindings/bindings.js")
},{"_process":28,"fs":21,"path":27}],14:[function(require,module,exports){
module.exports={
  "append": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "asking": {
    "arity": 1,
    "flags": [
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "auth": {
    "arity": 2,
    "flags": [
      "noscript",
      "loading",
      "stale",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "bgrewriteaof": {
    "arity": 1,
    "flags": [
      "admin"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "bgsave": {
    "arity": -1,
    "flags": [
      "admin"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "bitcount": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "bitfield": {
    "arity": -2,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "bitop": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 2,
    "keyStop": -1,
    "step": 1
  },
  "bitpos": {
    "arity": -3,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "blpop": {
    "arity": -3,
    "flags": [
      "write",
      "noscript"
    ],
    "keyStart": 1,
    "keyStop": -2,
    "step": 1
  },
  "brpop": {
    "arity": -3,
    "flags": [
      "write",
      "noscript"
    ],
    "keyStart": 1,
    "keyStop": -2,
    "step": 1
  },
  "brpoplpush": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "noscript"
    ],
    "keyStart": 1,
    "keyStop": 2,
    "step": 1
  },
  "client": {
    "arity": -2,
    "flags": [
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "cluster": {
    "arity": -2,
    "flags": [
      "admin"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "command": {
    "arity": 1,
    "flags": [
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "config": {
    "arity": -2,
    "flags": [
      "admin",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "dbsize": {
    "arity": 1,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "debug": {
    "arity": -1,
    "flags": [
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "decr": {
    "arity": 2,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "decrby": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "del": {
    "arity": -2,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "discard": {
    "arity": 1,
    "flags": [
      "noscript",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "dump": {
    "arity": 2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "echo": {
    "arity": 2,
    "flags": [
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "eval": {
    "arity": -3,
    "flags": [
      "noscript",
      "movablekeys"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "evalsha": {
    "arity": -3,
    "flags": [
      "noscript",
      "movablekeys"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "exec": {
    "arity": 1,
    "flags": [
      "noscript",
      "skip_monitor"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "exists": {
    "arity": -2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "expire": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "expireat": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "flushall": {
    "arity": -1,
    "flags": [
      "write"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "flushdb": {
    "arity": -1,
    "flags": [
      "write"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "geoadd": {
    "arity": -5,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "geodist": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "geohash": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "geopos": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "georadius": {
    "arity": -6,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "georadiusbymember": {
    "arity": -5,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "get": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "getbit": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "getrange": {
    "arity": 4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "getset": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hdel": {
    "arity": -3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hexists": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hget": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hgetall": {
    "arity": 2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hincrby": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hincrbyfloat": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hkeys": {
    "arity": 2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hlen": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hmget": {
    "arity": -3,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hmset": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "host:": {
    "arity": -1,
    "flags": [
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "hscan": {
    "arity": -3,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hset": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hsetnx": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hstrlen": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "hvals": {
    "arity": 2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "incr": {
    "arity": 2,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "incrby": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "incrbyfloat": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "info": {
    "arity": -1,
    "flags": [
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "keys": {
    "arity": 2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "lastsave": {
    "arity": 1,
    "flags": [
      "random",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "latency": {
    "arity": -2,
    "flags": [
      "admin",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "lindex": {
    "arity": 3,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "linsert": {
    "arity": 5,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "llen": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lpop": {
    "arity": 2,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lpush": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lpushx": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lrange": {
    "arity": 4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lrem": {
    "arity": 4,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "lset": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "ltrim": {
    "arity": 4,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "memory": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "mget": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "migrate": {
    "arity": -6,
    "flags": [
      "write",
      "movablekeys"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "module": {
    "arity": -2,
    "flags": [
      "admin",
      "noscript"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "monitor": {
    "arity": 1,
    "flags": [
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "move": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "mset": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 2
  },
  "msetnx": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 2
  },
  "multi": {
    "arity": 1,
    "flags": [
      "noscript",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "object": {
    "arity": 3,
    "flags": [
      "readonly"
    ],
    "keyStart": 2,
    "keyStop": 2,
    "step": 2
  },
  "persist": {
    "arity": 2,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "pexpire": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "pexpireat": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "pfadd": {
    "arity": -2,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "pfcount": {
    "arity": -2,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "pfdebug": {
    "arity": -3,
    "flags": [
      "write"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "pfmerge": {
    "arity": -2,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "pfselftest": {
    "arity": 1,
    "flags": [
      "admin"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "ping": {
    "arity": -1,
    "flags": [
      "stale",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "post": {
    "arity": -1,
    "flags": [
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "psetex": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "psubscribe": {
    "arity": -2,
    "flags": [
      "pubsub",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "psync": {
    "arity": 3,
    "flags": [
      "readonly",
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "pttl": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "publish": {
    "arity": 3,
    "flags": [
      "pubsub",
      "loading",
      "stale",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "pubsub": {
    "arity": -2,
    "flags": [
      "pubsub",
      "random",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "punsubscribe": {
    "arity": -1,
    "flags": [
      "pubsub",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "quit": {
    "arity": 1,
    "flags": [
      "loading",
      "stale",
      "readonly"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "randomkey": {
    "arity": 1,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "readonly": {
    "arity": 1,
    "flags": [
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "readwrite": {
    "arity": 1,
    "flags": [
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "rename": {
    "arity": 3,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 2,
    "step": 1
  },
  "renamenx": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 2,
    "step": 1
  },
  "replconf": {
    "arity": -1,
    "flags": [
      "admin",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "restore": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "restore-asking": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom",
      "asking"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "role": {
    "arity": 1,
    "flags": [
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "rpop": {
    "arity": 2,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "rpoplpush": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 2,
    "step": 1
  },
  "rpush": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "rpushx": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "sadd": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "save": {
    "arity": 1,
    "flags": [
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "scan": {
    "arity": -2,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "scard": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "script": {
    "arity": -2,
    "flags": [
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "sdiff": {
    "arity": -2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "sdiffstore": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "select": {
    "arity": 2,
    "flags": [
      "loading",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "set": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "setbit": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "setex": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "setnx": {
    "arity": 3,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "setrange": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "shutdown": {
    "arity": -1,
    "flags": [
      "admin",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "sinter": {
    "arity": -2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "sinterstore": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "sismember": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "slaveof": {
    "arity": 3,
    "flags": [
      "admin",
      "noscript",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "slowlog": {
    "arity": -2,
    "flags": [
      "admin"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "smembers": {
    "arity": 2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "smove": {
    "arity": 4,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 2,
    "step": 1
  },
  "sort": {
    "arity": -2,
    "flags": [
      "write",
      "denyoom",
      "movablekeys"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "spop": {
    "arity": -2,
    "flags": [
      "write",
      "random",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "srandmember": {
    "arity": -2,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "srem": {
    "arity": -3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "sscan": {
    "arity": -3,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "strlen": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "subscribe": {
    "arity": -2,
    "flags": [
      "pubsub",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "substr": {
    "arity": 4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "sunion": {
    "arity": -2,
    "flags": [
      "readonly",
      "sort_for_script"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "sunionstore": {
    "arity": -3,
    "flags": [
      "write",
      "denyoom"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "swapdb": {
    "arity": 3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "sync": {
    "arity": 1,
    "flags": [
      "readonly",
      "admin",
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "time": {
    "arity": 1,
    "flags": [
      "random",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "touch": {
    "arity": -2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "ttl": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "type": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "unlink": {
    "arity": -2,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "unsubscribe": {
    "arity": -1,
    "flags": [
      "pubsub",
      "noscript",
      "loading",
      "stale"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "unwatch": {
    "arity": 1,
    "flags": [
      "noscript",
      "fast"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "wait": {
    "arity": 3,
    "flags": [
      "noscript"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "watch": {
    "arity": -2,
    "flags": [
      "noscript",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": -1,
    "step": 1
  },
  "zadd": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zcard": {
    "arity": 2,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zcount": {
    "arity": 4,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zincrby": {
    "arity": 4,
    "flags": [
      "write",
      "denyoom",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zinterstore": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom",
      "movablekeys"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  },
  "zlexcount": {
    "arity": 4,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrange": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrangebylex": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrangebyscore": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrank": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrem": {
    "arity": -3,
    "flags": [
      "write",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zremrangebylex": {
    "arity": 4,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zremrangebyrank": {
    "arity": 4,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zremrangebyscore": {
    "arity": 4,
    "flags": [
      "write"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrevrange": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrevrangebylex": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrevrangebyscore": {
    "arity": -4,
    "flags": [
      "readonly"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zrevrank": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zscan": {
    "arity": -3,
    "flags": [
      "readonly",
      "random"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zscore": {
    "arity": 3,
    "flags": [
      "readonly",
      "fast"
    ],
    "keyStart": 1,
    "keyStop": 1,
    "step": 1
  },
  "zunionstore": {
    "arity": -4,
    "flags": [
      "write",
      "denyoom",
      "movablekeys"
    ],
    "keyStart": 0,
    "keyStop": 0,
    "step": 0
  }
}
},{}],15:[function(require,module,exports){
'use strict'

var commands = require('./commands')

/**
 * Redis command list
 *
 * All commands are lowercased.
 *
 * @var {string[]}
 * @public
 */
exports.list = Object.keys(commands)

var flags = {}
exports.list.forEach(function (commandName) {
  flags[commandName] = commands[commandName].flags.reduce(function (flags, flag) {
    flags[flag] = true
    return flags
  }, {})
})
/**
 * Check if the command exists
 *
 * @param {string} commandName - the command name
 * @return {boolean} result
 * @public
 */
exports.exists = function (commandName) {
  return Boolean(commands[commandName])
}

/**
 * Check if the command has the flag
 *
 * Some of possible flags: readonly, noscript, loading
 * @param {string} commandName - the command name
 * @param {string} flag - the flag to check
 * @return {boolean} result
 * @public
 */
exports.hasFlag = function (commandName, flag) {
  if (!flags[commandName]) {
    throw new Error('Unknown command ' + commandName)
  }

  return Boolean(flags[commandName][flag])
}

/**
 * Get indexes of keys in the command arguments
 *
 * @param {string} commandName - the command name
 * @param {string[]} args - the arguments of the command
 * @param {object} [options] - options
 * @param {boolean} [options.parseExternalKey] - parse external keys
 * @return {number[]} - the list of the index
 * @public
 *
 * @example
 * ```javascript
 * getKeyIndexes('set', ['key', 'value']) // [0]
 * getKeyIndexes('mget', ['key1', 'key2']) // [0, 1]
 * ```
 */
exports.getKeyIndexes = function (commandName, args, options) {
  var command = commands[commandName]
  if (!command) {
    throw new Error('Unknown command ' + commandName)
  }

  if (!Array.isArray(args)) {
    throw new Error('Expect args to be an array')
  }

  var keys = []
  var i, keyStart, keyStop, parseExternalKey
  switch (commandName) {
    case 'zunionstore':
    case 'zinterstore':
      keys.push(0)
    // fall through
    case 'eval':
    case 'evalsha':
      keyStop = Number(args[1]) + 2
      for (i = 2; i < keyStop; i++) {
        keys.push(i)
      }
      break
    case 'sort':
      parseExternalKey = options && options.parseExternalKey
      keys.push(0)
      for (i = 1; i < args.length - 1; i++) {
        if (typeof args[i] !== 'string') {
          continue
        }
        var directive = args[i].toUpperCase()
        if (directive === 'GET') {
          i += 1
          if (args[i] !== '#') {
            if (parseExternalKey) {
              keys.push([i, getExternalKeyNameLength(args[i])])
            } else {
              keys.push(i)
            }
          }
        } else if (directive === 'BY') {
          i += 1
          if (parseExternalKey) {
            keys.push([i, getExternalKeyNameLength(args[i])])
          } else {
            keys.push(i)
          }
        } else if (directive === 'STORE') {
          i += 1
          keys.push(i)
        }
      }
      break
    case 'migrate':
      if (args[2] === '') {
        for (i = 5; i < args.length - 1; i++) {
          if (args[i].toUpperCase() === 'KEYS') {
            for (var j = i + 1; j < args.length; j++) {
              keys.push(j)
            }
            break
          }
        }
      } else {
        keys.push(2)
      }
      break
    default:
    // step has to be at least one in this case, otherwise the command does not contain a key
      if (command.step > 0) {
        keyStart = command.keyStart - 1
        keyStop = command.keyStop > 0 ? command.keyStop : args.length + command.keyStop + 1
        for (i = keyStart; i < keyStop; i += command.step) {
          keys.push(i)
        }
      }
      break
  }

  return keys
}

function getExternalKeyNameLength (key) {
  if (typeof key !== 'string') {
    key = String(key)
  }
  var hashPos = key.indexOf('->')
  return hashPos === -1 ? key.length : hashPos
}

},{"./commands":14}],16:[function(require,module,exports){
'use strict'

module.exports = require('./lib/parser')
module.exports.ReplyError = require('./lib/replyError')

},{"./lib/parser":18,"./lib/replyError":19}],17:[function(require,module,exports){
'use strict'

var hiredis = require('hiredis')
var ReplyError = require('../lib/replyError')

/**
 * Parse data
 * @param parser
 * @returns {*}
 */
function parseData (parser) {
  try {
    return parser.reader.get()
  } catch (err) {
    // Protocol errors land here
    // Reset the parser. Otherwise new commands can't be processed properly
    parser.reader = new hiredis.Reader(parser.options)
    parser.returnFatalError(new ReplyError(err.message))
  }
}

/**
 * Hiredis Parser
 * @param options
 * @constructor
 */
function HiredisReplyParser (options) {
  this.returnError = options.returnError
  this.returnFatalError = options.returnFatalError || options.returnError
  this.returnReply = options.returnReply
  this.name = 'hiredis'
  this.options = {
    return_buffers: !!options.returnBuffers
  }
  this.reader = new hiredis.Reader(this.options)
}

HiredisReplyParser.prototype.execute = function (data) {
  this.reader.feed(data)
  var reply = parseData(this)

  while (reply !== undefined) {
    if (reply && reply.name === 'Error') {
      this.returnError(new ReplyError(reply.message))
    } else {
      this.returnReply(reply)
    }
    reply = parseData(this)
  }
}

module.exports = HiredisReplyParser

},{"../lib/replyError":19,"hiredis":12}],18:[function(require,module,exports){
(function (Buffer){
'use strict'

var StringDecoder = require('string_decoder').StringDecoder
var decoder = new StringDecoder()
var ReplyError = require('./replyError')
var bufferPool = new Buffer(32 * 1024)
var bufferOffset = 0
var interval = null
var counter = 0
var notDecreased = 0

/**
 * Used for lengths and numbers only, faster perf on arrays / bulks
 * @param parser
 * @returns {*}
 */
function parseSimpleNumbers (parser) {
  var offset = parser.offset
  var length = parser.buffer.length - 1
  var number = 0
  var sign = 1

  if (parser.buffer[offset] === 45) {
    sign = -1
    offset++
  }

  while (offset < length) {
    var c1 = parser.buffer[offset++]
    if (c1 === 13) { // \r\n
      parser.offset = offset + 1
      return sign * number
    }
    number = (number * 10) + (c1 - 48)
  }
}

/**
 * Used for integer numbers in case of the returnNumbers option
 *
 * The maximimum possible integer to use is: Math.floor(Number.MAX_SAFE_INTEGER / 10)
 * Staying in a SMI Math.floor((Math.pow(2, 32) / 10) - 1) is even more efficient though
 *
 * @param parser
 * @returns {*}
 */
function parseStringNumbers (parser) {
  var offset = parser.offset
  var length = parser.buffer.length - 1
  var number = 0
  var res = ''

  if (parser.buffer[offset] === 45) {
    res += '-'
    offset++
  }

  while (offset < length) {
    var c1 = parser.buffer[offset++]
    if (c1 === 13) { // \r\n
      parser.offset = offset + 1
      if (number !== 0) {
        res += number
      }
      return res
    } else if (number > 429496728) {
      res += (number * 10) + (c1 - 48)
      number = 0
    } else if (c1 === 48 && number === 0) {
      res += 0
    } else {
      number = (number * 10) + (c1 - 48)
    }
  }
}

/**
 * Returns a string or buffer of the provided offset start and
 * end ranges. Checks `optionReturnBuffers`.
 *
 * If returnBuffers is active, all return values are returned as buffers besides numbers and errors
 *
 * @param parser
 * @param start
 * @param end
 * @returns {*}
 */
function convertBufferRange (parser, start, end) {
  parser.offset = end + 2
  if (parser.optionReturnBuffers === true) {
    return parser.buffer.slice(start, end)
  }

  return parser.buffer.toString('utf-8', start, end)
}

/**
 * Parse a '+' redis simple string response but forward the offsets
 * onto convertBufferRange to generate a string.
 * @param parser
 * @returns {*}
 */
function parseSimpleStringViaOffset (parser) {
  var start = parser.offset
  var offset = start
  var buffer = parser.buffer
  var length = buffer.length - 1

  while (offset < length) {
    if (buffer[offset++] === 13) { // \r\n
      return convertBufferRange(parser, start, offset - 1)
    }
  }
}

/**
 * Returns the string length via parseSimpleNumbers
 * @param parser
 * @returns {*}
 */
function parseLength (parser) {
  var string = parseSimpleNumbers(parser)
  if (string !== undefined) {
    return string
  }
}

/**
 * Parse a ':' redis integer response
 *
 * If stringNumbers is activated the parser always returns numbers as string
 * This is important for big numbers (number > Math.pow(2, 53)) as js numbers
 * are 64bit floating point numbers with reduced precision
 *
 * @param parser
 * @returns {*}
 */
function parseInteger (parser) {
  if (parser.optionStringNumbers) {
    return parseStringNumbers(parser)
  }
  return parseSimpleNumbers(parser)
}

/**
 * Parse a '$' redis bulk string response
 * @param parser
 * @returns {*}
 */
function parseBulkString (parser) {
  var length = parseLength(parser)
  if (length === undefined) {
    return
  }
  if (length === -1) {
    return null
  }
  var offsetEnd = parser.offset + length
  if (offsetEnd + 2 > parser.buffer.length) {
    parser.bigStrSize = offsetEnd + 2
    parser.bigOffset = parser.offset
    parser.totalChunkSize = parser.buffer.length
    parser.bufferCache.push(parser.buffer)
    return
  }

  return convertBufferRange(parser, parser.offset, offsetEnd)
}

/**
 * Parse a '-' redis error response
 * @param parser
 * @returns {Error}
 */
function parseError (parser) {
  var string = parseSimpleStringViaOffset(parser)
  if (string !== undefined) {
    if (parser.optionReturnBuffers === true) {
      string = string.toString()
    }
    return new ReplyError(string)
  }
}

/**
 * Parsing error handler, resets parser buffer
 * @param parser
 * @param error
 */
function handleError (parser, error) {
  parser.buffer = null
  parser.returnFatalError(error)
}

/**
 * Parse a '*' redis array response
 * @param parser
 * @returns {*}
 */
function parseArray (parser) {
  var length = parseLength(parser)
  if (length === undefined) {
    return
  }
  if (length === -1) {
    return null
  }
  var responses = new Array(length)
  return parseArrayElements(parser, responses, 0)
}

/**
 * Parse chunked redis array response
 * @param parser
 * @returns {*}
 */
function parseArrayChunks (parser) {
  return parseArrayElements(parser, parser.arrayCache, parser.arrayPos)
}

/**
 * Parse redis array response elements
 * @param parser
 * @param responses
 * @param i
 * @returns {*}
 */
function parseArrayElements (parser, responses, i) {
  var bufferLength = parser.buffer.length
  while (i < responses.length) {
    var offset = parser.offset
    if (parser.offset >= bufferLength) {
      parser.arrayCache = responses
      parser.arrayPos = i
      parser.offset = offset
      return
    }
    var response = parseType(parser, parser.buffer[parser.offset++])
    if (response === undefined) {
      parser.arrayCache = responses
      parser.arrayPos = i
      parser.offset = offset
      return
    }
    responses[i] = response
    i++
  }

  return responses
}

/**
 * Called the appropriate parser for the specified type.
 * @param parser
 * @param type
 * @returns {*}
 */
function parseType (parser, type) {
  switch (type) {
    case 36: // $
      return parseBulkString(parser)
    case 58: // :
      return parseInteger(parser)
    case 43: // +
      return parseSimpleStringViaOffset(parser)
    case 42: // *
      return parseArray(parser)
    case 45: // -
      return parseError(parser)
    default:
      var err = new ReplyError('Protocol error, got ' + JSON.stringify(String.fromCharCode(type)) + ' as reply type byte', 20)
      err.offset = parser.offset
      err.buffer = JSON.stringify(parser.buffer)
      return handleError(parser, err)
  }
}

// All allowed options including their typeof value
var optionTypes = {
  returnError: 'function',
  returnFatalError: 'function',
  returnReply: 'function',
  returnBuffers: 'boolean',
  stringNumbers: 'boolean',
  name: 'string'
}

/**
 * Javascript Redis Parser
 * @param options
 * @constructor
 */
function JavascriptRedisParser (options) {
  if (!(this instanceof JavascriptRedisParser)) {
    return new JavascriptRedisParser(options)
  }
  if (!options || !options.returnError || !options.returnReply) {
    throw new TypeError('Please provide all return functions while initiating the parser')
  }
  for (var key in options) {
    if (optionTypes.hasOwnProperty(key) && typeof options[key] !== optionTypes[key]) {
      throw new TypeError('The options argument contains the property "' + key + '" that is either unkown or of a wrong type')
    }
  }
  if (options.name === 'hiredis') {
    /* istanbul ignore next: hiredis is only supported for legacy usage */
    try {
      var Hiredis = require('./hiredis')
      console.error(new TypeError('Using hiredis is discouraged. Please use the faster JS parser by removing the name option.').stack.replace('Error', 'Warning'))
      return new Hiredis(options)
    } catch (e) {
      console.error(new TypeError('Hiredis is not installed. Please remove the `name` option. The (faster) JS parser is used instead.').stack.replace('Error', 'Warning'))
    }
  }
  this.optionReturnBuffers = !!options.returnBuffers
  this.optionStringNumbers = !!options.stringNumbers
  this.returnError = options.returnError
  this.returnFatalError = options.returnFatalError || options.returnError
  this.returnReply = options.returnReply
  this.name = 'javascript'
  this.offset = 0
  this.buffer = null
  this.bigStrSize = 0
  this.bigOffset = 0
  this.totalChunkSize = 0
  this.bufferCache = []
  this.arrayCache = null
  this.arrayPos = 0
}

/**
 * Concat a bulk string containing multiple chunks
 *
 * Notes:
 * 1) The first chunk might contain the whole bulk string including the \r
 * 2) We are only safe to fully add up elements that are neither the first nor any of the last two elements
 *
 * @param parser
 * @param buffer
 * @returns {String}
 */
function concatBulkString (parser) {
  var list = parser.bufferCache
  var chunks = list.length
  var offset = parser.bigStrSize - parser.totalChunkSize
  parser.offset = offset
  if (offset === 1) {
    if (chunks === 2) {
      return list[0].toString('utf8', parser.bigOffset, list[0].length - 1)
    }
    chunks--
  }
  var res = decoder.write(list[0].slice(parser.bigOffset))
  for (var i = 1; i < chunks - 1; i++) {
    res += decoder.write(list[i])
  }
  res += decoder.end(list[i].slice(0, offset - 2))
  return res
}

/**
 * Decrease the bufferPool size over time
 * @returns {undefined}
 */
function decreaseBufferPool () {
  if (bufferPool.length > 50 * 1024) {
    // Balance between increasing and decreasing the bufferPool
    if (counter === 1 || notDecreased > counter * 2) {
      // Decrease the bufferPool by 10% by removing the first 10% of the current pool
      var sliceLength = Math.floor(bufferPool.length / 10)
      if (bufferOffset <= sliceLength) {
        bufferOffset = 0
      } else {
        bufferOffset -= sliceLength
      }
      bufferPool = bufferPool.slice(sliceLength, bufferPool.length)
    } else {
      notDecreased++
      counter--
    }
  } else {
    clearInterval(interval)
    counter = 0
    notDecreased = 0
    interval = null
  }
}

/**
 * Concat the collected chunks from parser.bufferCache
 * @param parser
 * @param length
 * @returns {Buffer}
 */
function concatBuffer (parser, length) {
  var list = parser.bufferCache
  var pos = bufferOffset
  length -= parser.offset
  if (bufferPool.length < length + bufferOffset) {
    // Increase the bufferPool size
    var multiplier = length > 1024 * 1024 * 75 ? 2 : 3
    if (bufferOffset > 1024 * 1024 * 120) {
      bufferOffset = 1024 * 1024 * 50
    }
    bufferPool = new Buffer(length * multiplier + bufferOffset)
    bufferOffset = 0
    counter++
    pos = 0
    if (interval === null) {
      interval = setInterval(decreaseBufferPool, 50)
    }
  }
  list[0].copy(bufferPool, pos, parser.offset, list[0].length)
  pos += list[0].length - parser.offset
  for (var i = 1; i < list.length; i++) {
    list[i].copy(bufferPool, pos)
    pos += list[i].length
  }
  var buffer = bufferPool.slice(bufferOffset, length + bufferOffset)
  bufferOffset += length
  return buffer
}

/**
 * Parse the redis buffer
 * @param buffer
 * @returns {undefined}
 */
JavascriptRedisParser.prototype.execute = function execute (buffer) {
  var arr
  if (this.buffer === null) {
    this.buffer = buffer
    this.offset = 0
  } else if (this.bigStrSize === 0) {
    var oldLength = this.buffer.length
    var remainingLength = oldLength - this.offset
    var newBuffer = new Buffer(remainingLength + buffer.length)
    this.buffer.copy(newBuffer, 0, this.offset, oldLength)
    buffer.copy(newBuffer, remainingLength, 0, buffer.length)
    this.buffer = newBuffer
    this.offset = 0
    if (this.arrayCache) {
      arr = parseArrayChunks(this)
      if (!arr) {
        return
      }
      this.returnReply(arr)
      this.arrayCache = null
    }
  } else if (this.totalChunkSize + buffer.length >= this.bigStrSize) {
    this.bufferCache.push(buffer)
    if (this.optionReturnBuffers === false && !this.arrayCache) {
      this.returnReply(concatBulkString(this))
      this.buffer = buffer
    } else {
      this.buffer = concatBuffer(this, this.totalChunkSize + buffer.length)
      this.offset = 0
      if (this.arrayCache) {
        arr = parseArrayChunks(this)
        if (!arr) {
          this.bigStrSize = 0
          this.bufferCache = []
          return
        }
        this.returnReply(arr)
        this.arrayCache = null
      }
    }
    this.bigStrSize = 0
    this.bufferCache = []
  } else {
    this.bufferCache.push(buffer)
    this.totalChunkSize += buffer.length
    return
  }

  while (this.offset < this.buffer.length) {
    var offset = this.offset
    var type = this.buffer[this.offset++]
    var response = parseType(this, type)
    if (response === undefined) {
      if (!this.arrayCache) {
        this.offset = offset
      }
      return
    }

    if (type === 45) {
      this.returnError(response)
    } else {
      this.returnReply(response)
    }
  }

  this.buffer = null
}

module.exports = JavascriptRedisParser

}).call(this,require("buffer").Buffer)
},{"./hiredis":17,"./replyError":19,"buffer":22,"string_decoder":33}],19:[function(require,module,exports){
'use strict'

var util = require('util')

function ReplyError (message, newLimit) {
  var limit = Error.stackTraceLimit
  Error.stackTraceLimit = newLimit || 2
  Error.call(this, message)
  Error.captureStackTrace(this, this.constructor)
  Error.stackTraceLimit = limit
  Object.defineProperty(this, 'message', {
    value: message || '',
    writable: true
  })
}

util.inherits(ReplyError, Error)

Object.defineProperty(ReplyError.prototype, 'name', {
  value: 'ReplyError',
  writable: true
})

module.exports = ReplyError

},{"util":38}],20:[function(require,module,exports){
var redis = require('redis');

var HOST = "192.168.1.83";
var PORT = "6379";

var client = redis.createClient(PORT,HOST);

var names = [];
var scores = [];

client.on('connect', function(err, reply){
	console.log('You did it.');

	if(err){
		throw err;
	}
})

client.hgetall('players', function (err, dbset){
	for(i in dbset){
		names.push(i);
		scores.push(parseInt(dbset[i]));
	}
})



for(i=0; i<10; i++){
	var newElement = document.createElement('div');
	var unitNum = 1;
	if (!(i%2)){
		unitNum=2;
	}
	j=i+1;
	newElement.innerHTML = '<div id = "scoreUnit'+unitNum+'" class="inline"><div id= "user" class="inline">'+j+'. '+names[i]+'</div><div id= "score" class="inline">'+userScore[i]+'</div></div>';
	document.getElementById("scoreboard").appendChild(newElement);
}


},{"redis":1}],21:[function(require,module,exports){

},{}],22:[function(require,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('isarray')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

/*
 * Export kMaxLength after typed array support is determined.
 */
exports.kMaxLength = kMaxLength()

function typedArraySupport () {
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = {__proto__: Uint8Array.prototype, foo: function () { return 42 }}
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

function createBuffer (that, length) {
  if (kMaxLength() < length) {
    throw new RangeError('Invalid typed array length')
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = new Uint8Array(length)
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    if (that === null) {
      that = new Buffer(length)
    }
    that.length = length
  }

  return that
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  if (!Buffer.TYPED_ARRAY_SUPPORT && !(this instanceof Buffer)) {
    return new Buffer(arg, encodingOrOffset, length)
  }

  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(this, arg)
  }
  return from(this, arg, encodingOrOffset, length)
}

Buffer.poolSize = 8192 // not used by this implementation

// TODO: Legacy, not needed anymore. Remove in next major version.
Buffer._augment = function (arr) {
  arr.__proto__ = Buffer.prototype
  return arr
}

function from (that, value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return fromArrayBuffer(that, value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(that, value, encodingOrOffset)
  }

  return fromObject(that, value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(null, value, encodingOrOffset, length)
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
  if (typeof Symbol !== 'undefined' && Symbol.species &&
      Buffer[Symbol.species] === Buffer) {
    // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
    Object.defineProperty(Buffer, Symbol.species, {
      value: null,
      configurable: true
    })
  }
}

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  } else if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }
}

function alloc (that, size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(that, size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(that, size).fill(fill, encoding)
      : createBuffer(that, size).fill(fill)
  }
  return createBuffer(that, size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(null, size, fill, encoding)
}

function allocUnsafe (that, size) {
  assertSize(size)
  that = createBuffer(that, size < 0 ? 0 : checked(size) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < size; ++i) {
      that[i] = 0
    }
  }
  return that
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(null, size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(null, size)
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  var length = byteLength(string, encoding) | 0
  that = createBuffer(that, length)

  var actual = that.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    that = that.slice(0, actual)
  }

  return that
}

function fromArrayLike (that, array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  that = createBuffer(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array, byteOffset, length) {
  array.byteLength // this throws if `array` is not a valid ArrayBuffer

  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('\'offset\' is out of bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('\'length\' is out of bounds')
  }

  if (byteOffset === undefined && length === undefined) {
    array = new Uint8Array(array)
  } else if (length === undefined) {
    array = new Uint8Array(array, byteOffset)
  } else {
    array = new Uint8Array(array, byteOffset, length)
  }

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = array
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromArrayLike(that, array)
  }
  return that
}

function fromObject (that, obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    that = createBuffer(that, len)

    if (that.length === 0) {
      return that
    }

    obj.copy(that, 0, 0, len)
    return that
  }

  if (obj) {
    if ((typeof ArrayBuffer !== 'undefined' &&
        obj.buffer instanceof ArrayBuffer) || 'length' in obj) {
      if (typeof obj.length !== 'number' || isnan(obj.length)) {
        return createBuffer(that, 0)
      }
      return fromArrayLike(that, obj)
    }

    if (obj.type === 'Buffer' && isArray(obj.data)) {
      return fromArrayLike(that, obj.data)
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.')
}

function checked (length) {
  // Note: cannot use `length < kMaxLength()` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' &&
      (ArrayBuffer.isView(string) || string instanceof ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// The property is used by `Buffer.isBuffer` and `is-buffer` (in Safari 5-7) to detect
// Buffer instances.
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset  // Coerce to Number.
  if (isNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (Buffer.TYPED_ARRAY_SUPPORT &&
        typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new TypeError('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = this.subarray(start, end)
    newBuf.__proto__ = Buffer.prototype
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; ++i) {
      newBuf[i] = this[i + start]
    }
  }

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; ++i) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; ++i) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; ++i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if (code < 256) {
        val = code
      }
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : utf8ToBytes(new Buffer(val, encoding).toString())
    var len = bytes.length
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function isnan (val) {
  return val !== val // eslint-disable-line no-self-compare
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"base64-js":23,"ieee754":24,"isarray":25}],23:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function placeHoldersCount (b64) {
  var len = b64.length
  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // the number of equal signs (place holders)
  // if there are two placeholders, than the two characters before it
  // represent one byte
  // if there is only one, then the three characters before it represent 2 bytes
  // this is just a cheap hack to not do indexOf twice
  return b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0
}

function byteLength (b64) {
  // base64 is 4/3 + up to two characters of the original data
  return b64.length * 3 / 4 - placeHoldersCount(b64)
}

function toByteArray (b64) {
  var i, j, l, tmp, placeHolders, arr
  var len = b64.length
  placeHolders = placeHoldersCount(b64)

  arr = new Arr(len * 3 / 4 - placeHolders)

  // if there are placeholders, only get up to the last complete 4 chars
  l = placeHolders > 0 ? len - 4 : len

  var L = 0

  for (i = 0, j = 0; i < l; i += 4, j += 3) {
    tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)]
    arr[L++] = (tmp >> 16) & 0xFF
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  if (placeHolders === 2) {
    tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[L++] = tmp & 0xFF
  } else if (placeHolders === 1) {
    tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var output = ''
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    output += lookup[tmp >> 2]
    output += lookup[(tmp << 4) & 0x3F]
    output += '=='
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + (uint8[len - 1])
    output += lookup[tmp >> 10]
    output += lookup[(tmp >> 4) & 0x3F]
    output += lookup[(tmp << 2) & 0x3F]
    output += '='
  }

  parts.push(output)

  return parts.join('')
}

},{}],24:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],25:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],26:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],27:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":28}],28:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],29:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],30:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],31:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],32:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":30,"./encode":31}],33:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = require('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":22}],34:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = require('punycode');
var util = require('./util');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

},{"./util":35,"punycode":29,"querystring":32}],35:[function(require,module,exports){
'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

},{}],36:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],37:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],38:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":37,"_process":28,"inherits":36}]},{},[20]);
