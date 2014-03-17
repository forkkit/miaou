// postgresql persistence
// Usage :
//   
//  db.on(req.user)                             // returns a promise bound to the connection taken from the pool
//  .then(db.updateUser)                        // querying functions are available on the db object and use the connection (context of the call)
//  .then(function(user){                       // when you can't use the simple form
//      if (!user.bot) return this.ping(uid)    // `this` is the connection
//  }).finally(db.off);                         // releases the connection which is returned to the pool
// 
//  It's also possible to do transactions :
//
//  db.on(someArg)
//  .then(db.begin)
//  .then(db.doThing)
//  .then(db.doOtherThing)
//  .then(db.commit)
//  .catch(function(err){
//	    alert(err);
//      this.rollback();
//   }).finally(db.off);

var pg = require('pg').native,
	Promise = require("bluebird"),
	fs = Promise.promisifyAll(require("fs")),
	path = require("path"),
	MAX_AGE_FOR_EDIT = 5000+10, // +10 : additionnal delay to not issue an error if the browser was just at the max time
	MAX_AGE_FOR_TOTAL_DELETION = 2*60,
	pool;

Promise.longStackTraces(); // this will be removed in production in the future

// The connection object which is used for all postgress accesses from other files
function Con(){}
var proto = Con.prototype;

var NoRowError = exports.NoRowError = function(){};
NoRowError.prototype = Object.create(Error.prototype);

//////////////////////////////////////////////// #users

// fetches a user found by the OAuth profile, creates it if it doesn't exist
// Private fields are included in the returned object
proto.getCompleteUserFromOAuthProfile = function(profile){
	var oauthid = profile.id || profile.user_id, // id for google, github and reddit, user_id for stackexchange
		displayName = profile.displayName || profile.display_name || profile.name, // displayName for google and github, display_name for stackexchange, name for reddit
		provider = profile.provider;
	if (!oauthid) throw new Error('no id found in OAuth profile');
	var con = this, resolver = Promise.defer(),
		email = null, returnedCols = 'id, name, oauthdisplayname, email';
	if (profile.emails && profile.emails.length) email = profile.emails[0].value; // google, github
	con.client.query('select '+returnedCols+' from player where oauthprovider=$1 and oauthid=$2', [provider, oauthid], function(err, result){
		if (err) {
			resolver.reject(err);
		} else if (result.rows.length) {
			resolver.resolve(result.rows[0]);
		} else {
			console.dir(profile);
			resolver.resolve(con.queryRow(
				'insert into player (oauthid, oauthprovider, email, oauthdisplayname) values ($1, $2, $3, $4) returning '+returnedCols,
				[oauthid, provider, email, displayName]
			));
		}
	});
	return resolver.promise.bind(this);
}

// returns an existing user found by his id
// Only public fields are returned
// Private fields are included in the returned object
proto.getUserById = function(id){
	return this.queryRow('select id, name, oauthdisplayname, email from player where id=$1', [id]);
}

// right now it only updates the name, I'll enrich it if the need arises
proto.updateUser = function(user){
	return this.queryRow('update player set name=$1 where id=$2', [user.name, user.id]);
}

proto.listRecentUsers = function(roomId, N){
	return this.queryRows(
		"select message.author as id, min(player.name) as name, max(message.created) as mc from message join player on player.id=message.author"+
		" where message.room=$1 group by message.author order by mc desc limit $2", [roomId, N]
	);
}

///////////////////////////////////////////// #rooms

proto.storeRoom = function(r, author, authlevel) {
	if (!r.id) return this.createRoom(r, [author]);
	if (authlevel==="own") {
		return this.queryRow(
			"update room set name=$1, private=$2, listed=$3, dialog=$4, description=$5 where id=$6",
			[r.name, r.private, r.listed, r.dialog, r.description||'', r.id]
		);
	} else { // implied : "admin"
		return this.queryRow(
			"update room set name=$1, listed=$2, description=$3 where id=$4",
			[r.name, r.listed, r.description||'', r.id]
		);			
	}
}

proto.createRoom = function(r, owners){
	return this.queryRow(
		'insert into room (name, private, listed, dialog, description) values ($1, $2, $3, $4, $5) returning id',
		[r.name, r.private, r.listed, r.dialog, r.description||'']
	).then(function(row){
		r.id = row.id;
		return owners;
	}).map(function(user){
		return this.queryRow(
			'insert into room_auth (room, player, auth, granted) values ($1, $2, $3, $4)',
			[r.id, user.id, 'own', now()]
		);
	})
}

// obtains a lounge : a room initially made for a private discussion between two users
proto.getLounge = function(userA, userB) {
	var con = this, resolver = Promise.defer();
	this.client.query(
		"select * from room r, room_auth aa, room_auth ab"+
		" where r.private is true and r.listed is false and r.dialog is true"+
		" and aa.room=r.id and aa.player=$1 and aa.auth>='admin'"+
		" and ab.room=r.id and ab.player=$2 and ab.auth>='admin'"+
		" and not exists(select * from room_auth where room=r.id and player!=$1 and player!=$2)",
		[userA.id, userB.id], function(err, res)
	{
		if (err) return resolver.reject(err);
		if (res.rows.length) return resolver.resolve(res.rows[0]);		
		var baseName = userA.name.slice(0,20) + ' & ' + userB.name.slice(0,20), i=0, 
			description = 'A private lounge for '+userA.name+' and '+userB.name;
		(function tryName(){
			var name = i++ ? baseName + ' - ' + i : baseName;
			con.client.query("select id from room where name=$1", [name], function(err, res){
				if (err) return resolver.reject(err);
				if (res.rows.length) return tryName();
				var room = {name:name, description:description, private:true, listed:false, dialog:true};
				con.createRoom(room, [userA,userB]).then(function(){ resolver.resolve(room) });
			});			
		})();
	});
	return resolver.promise.bind(this);
}

// returns an existing room found by its id
proto.fetchRoom = function(id){
	return this.queryRow('select id, name, description, private, listed, dialog from room where id=$1', [id]);
}

// returns an existing room found by its id and the user's auth level
proto.fetchRoomAndUserAuth = function(roomId, userId){
	if (!roomId) throw new NoRowError();
	return this.queryRow('select id, name, description, private, listed, dialog, auth from room left join room_auth a on a.room=room.id and a.player=$1 where room.id=$2', [userId, roomId]);
}

// lists the rooms a user can access, either public or whose access was explicitely granted
proto.listAccessibleRooms = function(userId){
	return this.queryRows(
		"select id, name, description, private, dialog, listed, auth from room r left join room_auth a on a.room=r.id and a.player=$1"+
		" where private is false or auth is not null order by auth desc nulls last, name", [userId]
	);
}

// lists the rooms that should make it to the front page :
proto.listFrontPageRooms = function(userId){
	return this.queryRows(
		"select r.id, name, description, private, listed, dialog, auth,"+
		" (select count (*) from message m where m.room = r.id) as messageCount,"+
		" (select max (id) from message m where m.room = r.id and m.author=$1) as lastmessage"+
		" from room r left join room_auth a on a.room=r.id and a.player=$1"+  
		" where listed is true or auth is not null"+
		" order by auth desc nulls last, lastmessage desc, private desc, messageCount desc limit 200", [userId]
	);
}

proto.listRecentUserRooms = function(userId){
	return this.queryRows(
		"select m.id, m.number, m.last_created, r.name, r.description, r.private, r.listed, r.dialog"+
		" from ("+
			"select m.room as id, count(*) number, max(created) last_created"+
			" from message m"+
			" where author=$1"+
			" group by room "+
		") m"+
		" join room r on r.id = m.id"+
		" where r.listed is true"+
		" order by m.last_created desc limit 10", [userId]
	);
}

///////////////////////////////////////////// #auths

proto.deleteAccessRequests = function(roomId, userId){
	return this.execute('delete from access_request where room=$1 and player=$2', [roomId, userId])
}

proto.insertAccessRequest = function(roomId, userId, message){
	return this.queryRow(
		'insert into access_request (room, player, requested, request_message) values ($1, $2, $3, $4) returning *',
		[roomId, userId, now(), message]
	);
}

// userId : optionnal
proto.listOpenAccessRequests = function(roomId, userId){
	var sql = "select player,name,requested,request_message from player p,access_request r where r.denied is null and r.player=p.id and room=$1", args = [roomId];		
	if (userId) {
		sql += " and player=?";
		args.push(userId);
	}
	return this.queryRows(sql, args);
}

proto.getLastAccessRequest = function(roomId, userId){
	return this.queryRow(
		"select player,requested,request_message,denied,deny_message from access_request where room=$1 and player=$2 order by denied desc limit 1",
		[roomId, userId], true
	);
}

// lists the authorizations a user has
proto.listUserAuths = function(userId){
	return this.queryRows("select id, name, description, auth from room r, room_auth a where a.room=r.id and a.player=$1", [userId]);
}

// lists the authorizations of the room
proto.listRoomAuths = function(roomId){
	return this.queryRows("select id, name, auth, player, granter, granted from player p, room_auth a where a.player=p.id and a.room=$1 order by auth desc, name", [roomId]);
}

// do actions on user rights
// userId : id of the user doing the action
proto.changeRights = function(actions, userId, room){
	var con = this;
	return Promise.map(actions, function(a){
		var sql, args;
		switch (a.cmd) {
		case "insert_auth": // we can assume there's no existing auth
			sql = "insert into room_auth (room, player, auth, granter, granted) values ($1, $2, $3, $4, $5)";
			args = [room.id, a.user, a.auth, userId, now()];
			break;
		case "delete_ar":
			sql = "delete from access_request where room=$1 and player=$2";
			args = [room.id, a.user];
			break;
		case "deny_ar":
			sql = "update access_request set denied=$1, deny_message=$2 where room=$3 and player=$4";
			args = [now(), a.message.slice(0,200), room.id, a.user];
			break;
		case "update_auth":
			// the exists part is used to check the user doing the change has at least as much auth than the modified user
			sql = "update room_auth ma set auth=$1 where ma.player=$2 and ma.room=$3 and exists (select * from room_auth ua where ua.player=$4 and ua.room=$5 and ua.auth>=ma.auth)";
			args = [a.auth, a.user, room.id, userId, room.id];
			break;
		case "delete_auth":
			// the exists part is used to check the user doing the change has at least as much auth than the modified user
			sql = "delete from room_auth ma where ma.player=$1 and ma.room=$2 and exists (select * from room_auth ua where ua.player=$3 and ua.room=$4 and ua.auth>=ma.auth)";
			args = [a.user, room.id, userId, room.id];
			break;
		}
		return con.queryRow(sql, args);
	});	
}

proto.checkAuthLevel = function(roomId, userId, minimalLevel){
	return this.queryRow(
		"select auth from room_auth where player=$1 and room=$2 and auth>=$3",
		[userId, roomId, minimalLevel]
	).catch(NoRowError, function(){
		return false;
	}).then(function(row){
		return row.auth;
	});
}

//////////////////////////////////////////////// #messages

// returns a query object usable for streaming messages for a specific user (including his votes)
// see calls of this function to see how the additional arguments are used 
proto.queryMessages = function(roomId, userId, N, chronoOrder){
	var args = [roomId, userId, N],
		sql = 'select message.id, author, player.name as authorname, content, message.created as created, message.changed, pin, star, up, down, vote, score from message'+
		' left join message_vote on message.id=message and message_vote.player=$2'+
		' inner join player on author=player.id where room=$1';
	for (var i=0, j=4; arguments[j+1]; i++) {
		sql += ' and message.id'+arguments[j]+'$'+(j++-i);
		args.push(arguments[j++]);
	}
	sql += ' order by message.id '+ ( chronoOrder ? 'asc' : 'desc') + ' limit $3';
	return this.client.query(sql, args);
}

// returns a query with the most recent messages of the room
// If before is provided, then we look for messages older than this (not included)
// If until is also provided, we don't want to look farther
proto.queryMessagesBefore = function(roomId, userId, N, before, until){
	return this.queryMessages(roomId, userId, N, false, '<', before, '>=', until);
}

// returns a query with the message messageId (if found)
//  and the following ones up to N ones and up to the one with id before
// If before is also provided, we don't want to look farther
proto.queryMessagesAfter = function(roomId, userId, N, messageId, before){
	return this.queryMessages(roomId, userId, N, true, '>=', messageId, '<=', before);	
}

proto.getNotableMessages = function(roomId, createdAfter){
	return this.queryRows(
		'select message.id, author, player.name as authorname, content, created, pin, star, up, down, score from message'+
		' inner join player on author=player.id where room=$1 and created>$2 and score>4'+
		' order by score desc limit 12', [roomId, createdAfter]
	);
}

proto.search = function(roomId, pattern, lang, N){
	return this.queryRows(
		"select message.id, author, player.name as authorname, content, created, pin, star, up, down, score from message"+
		" inner join player on author=player.id"+
		" where to_tsvector($1, content) @@ plainto_tsquery($1,$2) and room=$3 order by message.id desc limit $4",
		[lang, pattern, roomId, N]
	);
}

// builds an histogram, each record relative to a utc day
proto.messageHistogram = function(roomId, pattern, lang) {
	return pattern ? this.queryRows(
			"select count(*) n, min(id) m, floor(created/86400) d from message where room=$1"+
			" and to_tsvector($2, content) @@ plainto_tsquery($2,$3)"+
			" group by d order by d", [roomId, lang, pattern]
		) : this.queryRows("select count(*) n, min(id) m, floor(created/86400) d from message where room=$1 group by d order by d", [roomId]);
}

// fetches one message. Votes of the passed user are included
proto.getMessage = function(messageId, userId){
	return this.queryRow(
		'select message.id, author, player.name as authorname, content, message.created as created, message.changed, pin, star, up, down, vote, score from message'+
		' left join message_vote on message.id=message and message_vote.player=$2'+
		' inner join player on author=player.id'+
		' where message.id=$1', [messageId, userId]
	);
}

// if id is set, updates the message if the author & room matches
// else stores a message and sets its id
proto.storeMessage = function(m){
	if (m.id && m.changed) {
		return this.queryRow(
			'update message set content=$1, changed=$2 where id=$3 and room=$4 and author=$5 and created>'+(now()-MAX_AGE_FOR_EDIT)+' returning *',
			[m.content, m.changed, m.id, m.room, m.author]
		).then(function(m){
			if (!m.content.length && m.created>now()-MAX_AGE_FOR_TOTAL_DELETION) return this.queryRow(
				"delete from message where id=$1", [m.id]
			).then(function(){ return m });
			return m;
		});
	}
	return this.queryRow(
		'insert into message (room, author, content, created) values ($1, $2, $3, $4) returning id',
		[m.room, m.author, m.content, m.created]
	).then(function(row){
		m.id = row.id;
		return m;
	});
}

proto.updateGetMessage = function(messageId, expr, userId){
	return this.queryRow("update message set "+expr+" where id=$1", [messageId])
	.then(function(){
		return this.getMessage(messageId, userId);
	});
}

//////////////////////////////////////////////// #pings

proto.storePing = function(roomId, userId, messageId){
	return this.queryRow("insert into ping(room, player, message, created) values ($1,$2,$3,$4)", [roomId, userId, messageId, now()]);
}

// users must be a sanitized array of usernames
proto.storePings = function(roomId, users, messageId){
	return this.execute(
		"insert into ping (room, player, message, created) select " +
		roomId + ", id, " + messageId + ", " + now() +
		" from player where name in (" + users.map(function(n){ return "'"+n+"'" }).join(',') + ")"
	);
}

proto.deletePings = function(roomId, userId){
	return this.execute("delete from ping where room=$1 and player=$2", [roomId, userId]);
}

proto.fetchUserPings = function(userId) {
	return this.queryRows("select player, room, name, message from ping, room where player=$1 and room.id=ping.room", [userId]);
}

// returns the id and name of the rooms where the user has been pinged since a certain time (seconds since epoch)
proto.fetchUserPingRooms = function(userId, after) {
	return this.queryRows("select room, max(name) as roomname, min(created) as first, max(created) as last from ping, room where player=$1 and room.id=ping.room and created>$2 group by room", [userId, after]);
}

//////////////////////////////////////////////// #votes

proto.addVote = function(roomId, userId, messageId, level) {
	var sql, args;
	switch (level) {
	case 'pin': case 'star': case 'up': case 'down':
		sql = "insert into message_vote (message, player, vote) select $1, $2, $3";
		sql += " where exists(select * from message where id=$1 and room=$4)"; // to avoid users cheating by voting on messages they're not allowed to
		args = [messageId, userId, level, roomId];
		break;
	default:
		throw new Error('Unknown vote level');
	}
	return this.queryRow(sql, args)
	.then(function(){
		return this.updateGetMessage(messageId, level+"="+level+"+1", userId);
	});
}
proto.removeVote = function(roomId, userId, messageId, level) {
	return this.queryRow("delete from message_vote where message=$1 and player=$2 and vote=$3", [messageId, userId, level])
	.then(function(){
		return this.updateGetMessage(messageId, level+"="+level+"-1", userId);
	});
}

//////////////////////////////////////////////// #plugin

proto.storePlayerPluginInfo = function(plugin, userId, info) {
	return this.queryRow("insert into plugin_player_info (plugin, player, info) values($1, $2, $3)", [plugin, userId, info])
}

proto.getPlayerPluginInfo = function(plugin, userId) {
	return this.queryRow("select * from plugin_player_info where plugin=$1 and player=$2", [plugin, userId], true);
}

proto.deletePlayerPluginInfo = function(plugin, userId) {
	return this.queryRow("delete from plugin_player_info where plugin=$1 and player=$2", [plugin, userId], true);
}

//////////////////////////////////////////////// #patches & versions

proto.getComponentVersion = function(component){
	return this.queryRow("select version from db_version where component=$1", [component], true)
	.then(function(row){
		return row ? row.version : 0;
	});
}

// applies the not yet applied patches for a component. This is automatically called
//  for the core of miaou but it may also be called by plugins (including for
//  initial installation of the plugin)
exports.upgrade = function(component, patchDirectory, cb){
	patchDirectory = path.resolve(__dirname, '..', patchDirectory); // because we're in ./libs
	var startVersion, endVersion;
	on(component)
	.then(proto.getComponentVersion)
	.then(function(version){
		console.log('Component '+component+' : current version='+version);
		startVersion = version;
	}).then(function(){
		return fs.readdirAsync(patchDirectory)
	}).then(function(names){
		return names.map(function(name){
			var m = name.match(/^(\d+)-(.*).sql$/);
			return m ? { name:m[2],	num:+m[1], filename:name } : null;
		}).filter(function(p){ return p && p.num>startVersion })
		.sort(function(a,b){ return a.num-b.num });
	}).then(function(patches){
		if (!patches.length) return console.log('Component '+component+' is up to date.');
		endVersion = patches[patches.length-1].num;
		console.log('Component '+component+' must be upgraded from version '+startVersion+' to '+endVersion);			
		return Promise.cast(patches).bind(this)
		.then(proto.begin)
		.reduce(function(_, patch){
			console.log('Applying patch '+patch.num+' : '+patch.name);
			return Promise.cast(patchDirectory+'/'+patch.filename).bind(this)
			.then(fs.readFileAsync.bind(fs))
			.then(function(buffer){
				return buffer.toString().replace(/(#[^\n]*)?\n/g,' ').split(';')
				.map(function(s){ return s.trim() }).filter(function(s){ return s });
			}).map(function(statement){
				console.log(' Next statement :', statement);
				return this.execute(statement)
			});
		}, 'see https://github.com/petkaantonov/bluebird/issues/70')
		.then(function(){
			return this.execute("delete from db_version where component=$1", [component])
		}).then(function(){
			return this.execute("insert into db_version (component,version) values($1,$2)", [component, endVersion])
		}).then(proto.commit)
		.then(function(){
			console.log('Component '+component+' successfully upgraded to version '+endVersion)
		}).catch(function(err){
			console.log('An error prevented DB upgrade : ', err);
			console.log('All changes are rollbacked');
			return this.rollback();
		})
	}).finally(proto.off)
	.then(cb)
}

//////////////////////////////////////////////// #global API

function now(){
	return ~~(Date.now()/1000);
}

function logQuery(sql, args) { // used in debug
	console.log(sql.replace(/\$(\d+)/g, function(_,i){ var s=args[i-1]; return typeof s==="string" ? "'"+s+"'" : s }));
}

// must be called before any call to connect
exports.init = function(dbConfig, cb){
	var conString = dbConfig.url;
	pg.defaults.parseInt8 = true;
	pg.connect(conString, function(err, client, done){
		if (err) return console.log('Connection to PostgreSQL database failed');
		done();
		console.log('Connection to PostgreSQL database successful');
		pool = pg.pools.all[JSON.stringify(conString)];
		exports.upgrade('core', 'sql/patches', cb);
	})
}

// returns a promise bound to a connection, available to issue queries
//  The connection must be released using off
var on = exports.on = function(val){
	var con = new Con(), resolver = Promise.defer();
	pool.connect(function(err, client, done){
		if (err) {
			resolver.reject(err);
		} else {
			con.client = client;
			con.done = done;
			resolver.resolve(val);
		}
	});
	return resolver.promise.bind(con);
}

// releases the connection which returns to the pool
// It's ok to call this function more than once
proto.off = function(){
	if (this instanceof Con) {
		if (this.done) {
			this.done();
			this.done = null;
		} else {
			console.log('connection already released'); // no worry
		}
	} else {
		console.log('not a connection!'); // if this happens, there's probably a leaked connection
	}
}

// throws a NoRowError if no row was found (select) or affected (insert, delete, update)
//  apart if noErrorOnNoRow
proto.queryRow = function(sql, args, noErrorOnNoRow){
	var resolver = Promise.defer();
	this.client.query(sql, args, function(err, res){
		//~ logQuery(sql, args);
		if (err) {
			resolver.reject(err);
		} else if (res.rows.length) {
			resolver.resolve(res.rows[0]);
		} else if (res.rowCount) {
			resolver.resolve(res.rowCount);
		} else {
			if (noErrorOnNoRow) resolver.resolve(null);
			else resolver.reject(new NoRowError());
		}
	});
	return resolver.promise.bind(this);
}

proto.queryRows = proto.execute = function(sql, args){
	var resolver = Promise.defer();
	this.client.query(sql, args, function(err, res){
		//~ logQuery(sql, args);
		if (err) resolver.reject(err);
		else resolver.resolve(res.rows);
	});
	return resolver.promise.bind(this);
}

;['begin','rollback','commit'].forEach(function(s){
	proto[s] = function(arg){ return this.execute(s).then(function(){ return arg }) }
});

for (var fname in proto) {
	if (proto.hasOwnProperty(fname) && typeof proto[fname] === "function") {
		exports[fname] = proto[fname];
	}
}