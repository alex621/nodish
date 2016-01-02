var http = require('http');

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

function forwardRequest(req, res, headerCome, dataChunkCome, done){
	var proxyReq = http.request({
		hostname: "localhost",
		port: 8080,
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

function hash(req){
	var host = req.headers.host;
	var url = req.url;

	return host + url;
}

function purge(req, res){
	var hashKey = hash(req);
	cachee.purge(hashKey);
	res.writeHead(200, "Purged");
	res.end("Purged");
}

function headerComeAndWriteToRes(req, res, responseObj){
	res.writeHead(responseObj.statusCode, responseObj.statusMessage, responseObj.headers);
}

function dataChunkComeAndWriteToRes(req, res, chunk){
	res.write(chunk);
}

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

function doneButNoCache(req, res, responseObj){
	res.end();
}

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
		if (url == "/"){
			useCacheIfExist(req, res);

			return true;
		}
	}

	return false;
};

var reqCount = 0;
var server = http.createServer(function(req, res) {
	req.reqIdx = reqCount++;
	var handled = false;

	var method = req.method.toLowerCase();

	if (method == "get"){
		handled = recv(req, res);
	}else if (method == "purge"){
		purge(req, res);
		handled = true;
	}

	if (! handled){
		forwardRequest(req, res, headerComeAndWriteToRes, dataChunkComeAndWriteToRes, doneButNoCache);
	}
});


console.log("listening on port 80")
server.listen(80);