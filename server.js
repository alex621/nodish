var http = require('http');
var https = require('https');
var fs = require('fs');

var config = {
	//single backend only at this moment
	backend: {
		host: "localhost",
		port: 8080
	},

	https: {
		enabled: true,
		port: 443,
		keyFile: "kiwsy.key",
		certFile: "kiwsy.crt"
	},

	http: {
		enabled: true,
		port: 80
	}
};

/*
A class for handling cache.
Support defining ttl per cache object.
There are 2 cache maps, 1 for complete response object and 1 for partial response object.
*/
var cachee = {
	cacheMap: {},
	partialMap: {},

	defaultTTL: 120 * 1000,

	set: function (hashKey, cache){
		this.cacheMap[hashKey] = cache;
	},

	get: function (hashKey){
		if (! this.cacheMap.hasOwnProperty(hashKey)){
			return null;
		}
		var cache = this.cacheMap[hashKey];

		if (cache == null){
			return null;
		}

		var now = +new Date;
		var ttl = this.defaultTTL;
		if (cache.hasOwnProperty("ttl")){
			ttl = cache.ttl;
		}
		if (now - cache.updateTime > ttl){
			this.purge(hashKey);
			return null;
		}

		return cache;
	},

	purge: function (hashKey){
		this.cacheMap[hashKey] = null;
		delete this.cacheMap[hashKey];
	},

	setPartial: function (hashKey, cache){
		this.partialMap[hashKey] = cache;
	},

	getPartial: function (hashKey){
		if (! this.partialMap.hasOwnProperty(hashKey)){
			return null;
		}

		return this.partialMap[hashKey];
	},

	purgePartial: function (hashKey){
		this.partialMap[hashKey] = null;
		delete this.partialMap[hashKey];
	}
};

/*
A class for handling the request queue.
*/
var queuee = {
	queueMap: {},

	notEmpty: function (hashKey){
		return this.queueMap.hasOwnProperty(hashKey) && this.queueMap[hashKey].length > 0;
	},

	clear: function (hashKey){
		if (! this.queueMap.hasOwnProperty(hashKey)){
			return;
		}

		this.queueMap[hashKey].length = 0;
	},

	add: function (hashKey, req, res){
		if (! this.queueMap.hasOwnProperty(hashKey)){
			this.queueMap[hashKey] = [];
		}

		this.queueMap[hashKey].push({
			req: req,
			res: res
		});
	},

	each: function (hashKey, cb){
		if (! this.queueMap.hasOwnProperty(hashKey)){
			return;
		}

		if (! cb){
			return;
		}

		var queue = this.queueMap[hashKey];
		for (var i = 0, l = queue.length; i < l; i++){
			cb(queue[i]);
		}
	}
};

//A handy function for cloning object. To be used for modifying headers without polluting the original headers.
function clone(obj) {
    if(obj === null || typeof(obj) !== 'object' || 'isActiveClone' in obj)
        return obj;

    var temp = obj.constructor(); // changed

    for(var key in obj) {
        if(Object.prototype.hasOwnProperty.call(obj, key)) {
            obj['isActiveClone'] = null;
            temp[key] = clone(obj[key]);
            delete obj['isActiveClone'];
        }
    }    

    return temp;
}

/*
Create a request to the backend and perform the callbacks accordingly.
*/
function forwardRequest(req, res, headerCome, dataChunkCome, done){
	var proxyReq = http.request({
		hostname: config.backend.host,
		port: config.backend.port,
		method: req.method,
		path: req.url,
		headers: req.headers,
	}, function (proxyRes){
		var hashKey = hash(req);

		var responseObj = {
			statusCode: proxyRes.statusCode,
			statusMessage: proxyRes.statusMessage,
			headers: proxyRes.headers,
			rawBody: [],
			body: null
		};


		//process headers
		for (var k in responseObj.headers){
			var newK = k.toLowerCase();
			if (k != newK){
				responseObj.headers[newK] = responseObj.headers[k];
				delete responseObj.headers[k];
			}
		}

		delete responseObj.headers['transfer-encoding'];
		responseObj.headers['connection'] = 'Close';

		cachee.setPartial(hashKey, responseObj);

		headerCome(req, res, responseObj);

		proxyRes.on('data', function (chunk) {
			responseObj.rawBody.push(chunk);
			dataChunkCome(req, res, chunk);
		});
		proxyRes.on('end', function() {
			responseObj.body = Buffer.concat(responseObj.rawBody);
			responseObj.updateTime = +new Date;

			cachee.purgePartial(hashKey);
			done(req, res, responseObj);

			queuee.clear(hashKey);
		})
	});

	var bodyLength = 0;
	req.on("data", function (data){
		bodyLength += data.length;

		//so large, fuck you
		if (bodyLength > 1e6){
			req.connection.destroy();
			return;
		}

		proxyReq.write(data);
	})

	req.on("end", function (){
		proxyReq.end();
	});
}

//The hash function for producing the hash key of the cache for a request.
function hash(req){
	var host = req.headers.host;
	var url = req.url;

	return host + url;
}

//Purge the cache. Only exact matching is supported at this moment.
function purge(req, res){
	var hashKey = hash(req);
	cachee.purge(hashKey);
	res.writeHead(200, "Purged");
	res.end("Purged");
}



/*
The 3 functions, headerComeAndWriteToRes, dataChunkComeAndWriteToRes and doneButNoCache
handle the case that the request is not cached and forwarded to the backend directly.
They are used as the callbacks of forwardRequest().
*/
function headerComeAndWriteToRes(req, res, responseObj){
	res.writeHead(responseObj.statusCode, responseObj.statusMessage, responseObj.headers);
}

function dataChunkComeAndWriteToRes(req, res, chunk){
	res.write(chunk);
}

function doneButNoCache(req, res, responseObj){
	res.end();
}



/*
The 3 functions, headerComeAndWriteToQueue, dataChunkComeAndWriteToQueue and doneAndKeepCache
handle the case that the request is cached.
When data arrives, they forward the data to all the queued requests.
At the end, it writes the response object to cache such that it can be re-used later.
*/
function headerComeAndWriteToQueue(req, res, responseObj){
	var hashKey = hash(req);
	queuee.each(hashKey, function (obj){
		obj.res.writeHead(responseObj.statusCode, responseObj.statusMessage, responseObj.headers);
	});
}

function dataChunkComeAndWriteToQueue(req, res, chunk){
	var hashKey = hash(req);
	queuee.each(hashKey, function (obj){
		obj.res.write(chunk);
	});
}

function doneAndKeepCache(req, res, responseObj){
	var hashKey = hash(req);
	responseObj.ttl = 120 * 1000;
	cachee.set(hashKey, responseObj);

	queuee.each(hashKey, function (obj){
		obj.res.end();
	});
}

/*
When there are simultaneous requests to the same URL, the one that comes first will be forwarded to the backend.
Then latter one will stay in the queue. If there is any partial responded data, this function will return it to the latter request.
*/
function writeExistingResponseObj(hashKey, req, res){
	var responseObj = cachee.getPartial(hashKey);
	if (responseObj == null){
		return;
	}

	res.writeHead(responseObj.statusCode, responseObj.statusMessage, responseObj.headers);

	//TODO is there a case that the rawBody grows more items before the loop ends?
	for (var i = 0, l = responseObj.rawBody.length; i < l; i++){
		res.write(responseObj.rawBody[i]);
	}
}

/*
Respond the responseObj. The responseObj should be a complete response object.
Here you may modify the headers, the body or whatever you can think of.
** Note that the partial object is not passed through this function. The modification you made here will not affect the partial object.
*/
function respond(req, res, responseObj, hit){
	if (hit){
		var headers = clone(responseObj.headers);
		headers['x-nodish-hit'] = '1';
		res.writeHead(responseObj.statusCode, responseObj.statusMessage, headers);
	}else{
		res.writeHead(responseObj.statusCode, responseObj.statusMessage, responseObj.headers);
	}
	res.end(responseObj.body);
}

/*
As the name suggested, it first checks if it is cached or not (and also if it is expired or not).
If cache is available, simply responds with the cached object.
Otherwise, forward the request to the backend and cache it such that it can be re-used next time.

It also handles simultaneous requests to the same URL.
i.e. When there are 2 requests requesting the same URL, only 1 request will be forwarded to backend (the one comes first).
When the latter request comes, all the responded data from the former request will be sent to it.
*/
function useCacheIfExist(req, res){
	var hashKey = hash(req);

	var cache = cachee.get(hashKey);
	if (cache == null){
		var needToRequestAgain = false;

		if (! queuee.notEmpty(hashKey)){
			needToRequestAgain = true;
		}

		writeExistingResponseObj(hashKey, req, res);
		queuee.add(hashKey, req, res);

		if (needToRequestAgain){
			forwardRequest(req, res, headerComeAndWriteToQueue, dataChunkComeAndWriteToQueue, doneAndKeepCache);
		}
	}else{
		respond(req, res, cache, true);
	}
};

var recv = function (req, res){
	var host = req.headers.host;
	var url = req.url;

	if (host == "kiwsy.com"){
		var urlMatch = false;
		urlMatch = urlMatch || (url == "/");

		if (!urlMatch){
			urlMatch = urlMatch || (url.substr(0, 8) == "/wp-json");
		}

		if (!urlMatch){
			urlMatch = urlMatch || (url.substr(0, 19) == "/wp-content/uploads");
		}

		if (!urlMatch){
			urlMatch = urlMatch || (new RegExp("^/20[0-9][0-9]/").test(url));
		}

		if (urlMatch){
			req.headers.cookie = "";

			useCacheIfExist(req, res);

			return true;
		}
	}

	return false;
};

var requestHandler = function(req, res) {
	var handled = false;

	var method = req.method.toLowerCase();

	//Handle GET and PURGE requests only
	//Others like POST, PUT blablabla are forwarded directly
	if (method == "get"){
		handled = recv(req, res);
	}else if (method == "purge"){
		purge(req, res);
		handled = true;
	}

	if (! handled){
		forwardRequest(req, res, headerComeAndWriteToRes, dataChunkComeAndWriteToRes, doneButNoCache);
	}
};

if (config.https.enabled){
	https.createServer({
		key: fs.readFileSync(config.https.keyFile),
		cert: fs.readFileSync(config.https.certFile)
	}, requestHandler).listen(config.https.port);
}

if (config.http.enabled){
	http.createServer(requestHandler).listen(config.http.port);
}

console.log("Nodish started");
if (config.http.enabled){
	console.log("\tListening on " + config.http.port + " for HTTP");
}
if (config.https.enabled){
	console.log("\tListening on " + config.https.port + " for HTTPS");
}