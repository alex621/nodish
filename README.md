Nodish - An alternative of Varnish Cache in node.js
=================================

We use Varnish between the client and our backend server. It helps to support more concurrent accesses to our website. However, you need to use the domain specific language "VCL" to define the cache policy. I don't like it much. I prefer writing Javascript. Nodish is a pure Javascript (node.js) solution to replace Varnish in your server.

## The philosophy

There is only one single file in this project, server.js. The main proxy server logic is included in this file. There are also few pre-defined functions that help you build your own cache strategy. You may want to study each function to get to know what they are doing.

## How to use

### Define your own cache strategy

For a simple use case, you may just need to write your own cache logic in the function recv(). Yes. The naming strategy is a bit similar to Varnish such that you could be more familiar with the environment.

The cache logic that I am using in a production server is included for your reference. The arguments req and res are the request and response object provided by node.js. That means you can read/write any properties from/to them as you would do to other node.js application. (This is also why I prefer doing it in node.js instead of VCL)

### Point to the backend server

There is a function called forwardRequest(). As the name suggested, it forwards the request to the backend server. At this moment, the request info is coded inside this function. You may need to change the host name and the port to fit your use case.

### Run the server

In my environment, I can start the server by this command.

```bash
sudo node server.js
```

That simple. This starts a proxy server listening to port 80.
