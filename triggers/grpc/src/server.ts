import GrpcServer from "./GrpcServer.js";

const server = new GrpcServer({
	host: "0.0.0.0",
	port: 8443,
});

server.start();
