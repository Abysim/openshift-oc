var Telegram = require('node-telegram-bot-api');
var fs = require('fs');
var path = require('path');
var irc = require('./irc');
var nodeStatic = require('node-static');
var mkdirp = require('mkdirp');
var crypto = require('crypto');
var exec = require('child_process');
var dwebp = require('dwebp-bin');

// tries to read chat ids from a file
var readChatIds = function(arr) {
    console.log('\n');
    console.log('NOTE!');
    console.log('=====');

    var idMissing = false;
    try {
        var json = JSON.parse(fs.readFileSync(process.env.OPENSHIFT_DATA_DIR + '/.teleirc/chat_ids'));
        for (var i = 0; i < arr.length; i++) {
            var key = arr[i].tgGroup;
            if (key in json) {
                arr[i].tgChatId = json[key];
                console.log('id found for:', key, ':', json[key]);
            } else {
                console.log('id not found:', key);
                idMissing = true;
            }
        }
    } catch (e) {
        console.log('~/.teleirc/chat_ids file not found!');
        idMissing = true;
    }

    if (idMissing) {
        console.log(
            '\nPlease add your Telegram bot to a Telegram group and have' +
            '\nsomeone send a message to that group.' +
            '\nteleirc will then automatically store your group chat_id.');
    }

    console.log('\n');
};

var writeChatIds = function(config) {
    var json = {};
    for (var i = 0; i < config.channels.length; i++) {
        if (config.channels[i].tgChatId) {
            json[config.channels[i].tgGroup] = config.channels[i].tgChatId;
        }
    }
    json = JSON.stringify(json);
    fs.writeFile(process.env.OPENSHIFT_DATA_DIR + '/.teleirc/chat_ids', json, function(err) {
        if (err) {
            console.log('error while storing chat ID:');
            console.log(err);
        } else {
            console.log('successfully stored chat ID in ~/.teleirc/chat_ids');
        }
    });
};

var getName = function(user, config) {
    var name = config.nameFormat;

    if (user.username) {
        name = name.replace('%username%', '@' + user.username, 'g');
    } else {
        // if user lacks username, use fallback format string instead
        name = name.replace('%username%', config.usernameFallbackFormat, 'g');
    }

    name = name.replace('%firstName%', user.first_name || '', 'g');
    name = name.replace('%lastName%', user.last_name || '', 'g');

    // get rid of leading and trailing whitespace
    name = name.replace(/(^\s*)|(\s*$)/g, '');

    return name;
};

function randomValueBase64(len) {
    return crypto.randomBytes(Math.ceil(len * 3 / 4))
        .toString('base64')
        .slice(0, len)
        .replace(/\+/g, '0')
        .replace(/\//g, '0');
}

var serveFile = function(fileId, config, tg, callback) {
    var randomString = randomValueBase64(config.mediaRandomLenght);
    mkdirp(process.env.OPENSHIFT_DATA_DIR + '/.teleirc/files/' + randomString);
    tg.downloadFile(fileId, process.env.OPENSHIFT_DATA_DIR + '/.teleirc/files/' + randomString).then(function(filePath) {
        if (path.extname(filePath) == '.webp') {
            var newPath = path.dirname(filePath) + '/' + path.basename(filePath, '.webp') + '.png';
            exec.execFile(dwebp.path, [filePath, '-o', newPath], function (error) {
                if (!error) {
                    filePath = newPath;
                    callback(config.httpLocation + '/' + randomString + '/' + path.basename(filePath));
                } else {
                    console.error('Convert webp failed: ' + error);
                    var cloudconvert = new (require('cloudconvert'))(config.cloudConvertKey);
                    // create the process. see https://cloudconvert.com/apidoc#create
                    cloudconvert.createProcess({inputformat: 'webp', outputformat: 'png'}, function(err, process) {
                        if(err) {
                            console.error('CloudConvert Process creation failed: ' + err);
                        } else {
                            // start the process. see https://cloudconvert.com/apidoc#create
                            process.start({
                                outputformat: 'png',
                                input: 'upload'
                            }, function (err, process) {
                                if (err) {
                                    console.error('CloudConvert Process start failed: ' + err);
                                } else {
                                    // upload the input file. see https://cloudconvert.com/apidoc#upload
                                    process.upload(fs.createReadStream(filePath), null, function (err, process) {
                                        if (err) {
                                            console.error('CloudConvert Process upload failed: ' + err);
                                        } else {
                                            // wait until the process is finished (or completed with an error)
                                            process.wait(function (err, process) {
                                                if (err) {
                                                    console.error('CloudConvert Process failed: ' + err);
                                                } else {
                                                    // download it
                                                    process.download(fs.createWriteStream(newPath), null, function (err, process) {
                                                        if (err) {
                                                            console.error('CloudConvert Process download failed: ' + err);
                                                        } else {
                                                            filePath = newPath;
                                                            callback(config.httpLocation + '/' + randomString + '/' + path.basename(filePath));
                                                        }
                                                    });
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        } else {
            callback(config.httpLocation + '/' + randomString + '/' + path.basename(filePath));
        }
    });
};

module.exports = function(config, sendTo) {
    // start HTTP server for media files if configured to do so
    if (config.showMedia) {
        var fileServer = new nodeStatic.Server(process.env.OPENSHIFT_DATA_DIR + '/.teleirc/files');
        mkdirp(process.env.OPENSHIFT_DATA_DIR + '/.teleirc/files');

        require('http').createServer(function(req, res) {
            req.addListener('end', function() {
                fileServer.serve(req, res);
            }).resume();
        }).listen(config.httpLocalBindPort, config.httpLocalBindIP);
    }

    var tg = new Telegram(config.tgToken, {polling: true});

    readChatIds(config.channels);

    tg.on('message', function(msg) {
        var channel = config.channels.filter(function(channel) {
            return channel.tgGroup === msg.chat.title;
        })[0];

        if (!channel) {
            return;
        }

        if (!channel.tgChatId) {
            console.log('storing chat ID: ' + msg.chat.id);
            channel.tgChatId = msg.chat.id;
            writeChatIds(config);
        }

        if (msg.text && !msg.text.indexOf('/names')) {
            var names = sendTo.ircNames(channel);
            names.sort();
            names = 'Users on ' + (channel.chanAlias || channel.ircChan) + ':\n\n' +
                names.join(', ');

            return tg.sendMessage(channel.tgChatId, names);
        }

        // skip posts containing media if it's configured off
        if ((msg.audio || msg.document || msg.photo || msg.sticker || msg.video ||
            msg.voice || msg.contact || msg.location) && !config.showMedia) {
            return;
        }
        var text;
        
        var caption = '';
        if (msg.caption) {
            caption = msg.caption + ' ';
        }
        
        var forward = '';
        if (msg.forward_from) {
            forward = 'Fwd: ';
            var forwardName = getName(msg.forward_from, config);
            if (forwardName != '@' + config.tgBotName) {
                forward = forward + '<' + forwardName + '> ';
            }
        }
        
        var reply = '';
        if (msg.reply_to_message) {
            var replyName = getName(msg.reply_to_message.from, config);
            if (replyName == '@' + config.tgBotName) {
                var matches = msg.reply_to_message.text.match(/^<(.*?)>/);
                if (matches) {
                    replyName = matches[1];
                } else {
                    matches = msg.reply_to_message.text.match(/^\*(.*?) /);
                    if (matches) {
                        replyName = matches[1];
                    }
                }
            }
            reply = replyName + ': ';
        }
        
        if (msg.audio) {
            serveFile(msg.audio.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    '(Audio) ' + url);
            });
        } else if (msg.document) {
            serveFile(msg.document.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    '(File) ' + url);
            });
        } else if (msg.photo) {
            // pick the highest quality photo
            var photo = msg.photo[msg.photo.length - 1];

            serveFile(photo.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    caption + '(Photo, ' + photo.width + 'x' + photo.height + ') ' + url);
            });
        } else if (msg.new_chat_photo) {
            // pick the highest quality photo
            var chatPhoto = msg.new_chat_photo[msg.new_chat_photo.length - 1];

            serveFile(chatPhoto.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' +
                    '(New chat photo, ' + chatPhoto.width + 'x' + chatPhoto.height + ') ' + url);
            });
        } else if (msg.sticker) {
            serveFile(msg.sticker.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    '(Sticker, ' + msg.sticker.width + 'x' + msg.sticker.height + ') ' + url);
            });
        } else if (msg.video) {
            serveFile(msg.video.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    caption + '(Video, ' + msg.video.duration + 's) ' + url);
            });
        } else if (msg.voice) {
            serveFile(msg.voice.file_id, config, tg, function(url) {
                sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                    '(Voice, ' + msg.audio.duration + 's) ' + url);
            });
        } else if (msg.contact) {
            sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                '(Contact, ' + '"' + msg.contact.first_name + ' ' +
                msg.contact.last_name + '", ' +
                msg.contact.phone_number + ')');
        } else if (msg.location) {
            sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply +
                '(Location, ' + 'lon: ' + msg.location.longitude +
                              ', lat: ' + msg.location.latitude + ')');
        } else if (msg.new_chat_participant) {
            sendTo.irc(channel.ircChan, getName(msg.new_chat_participant, config) +
                ' was added by ' + getName(msg.from, config));
        } else if (msg.left_chat_participant) {
            sendTo.irc(channel.ircChan, getName(msg.left_chat_participant, config) +
                ' was removed by ' + getName(msg.from, config));
        } else {
            text = msg.text.replace(/\n/g , '\n<' + getName(msg.from, config) + '> ');
            sendTo.irc(channel.ircChan, '<' + getName(msg.from, config) + '> ' + forward + reply + text);
        }
    });

    sendTo.tg = function(channel, msg) {
        console.log('  >> relaying to TG: ' + msg);

        if (!channel.tgChatId) {
            var err = 'ERROR: No chat_id set! Add me to a Telegram group ' +
                      'and say hi so I can find your group\'s chat_id!';
            sendTo.irc(channel.ircChan, err);
            console.error(err);
            return;
        }

        tg.sendMessage(channel.tgChatId, msg);
    };
};
