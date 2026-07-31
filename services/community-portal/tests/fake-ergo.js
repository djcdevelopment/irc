"use strict";

const net = require("node:net");

function startFakeErgo({accounts = {}, operName, operPassword}) {
	const registry = new Map(
		Object.entries(accounts).map(([name, password]) => [
			name.toLowerCase(),
			password,
		])
	);
	const registrations = [];
	const suspensions = [];
	const amodes = [];
	const topics = [];
	const channels = new Set();
	const sockets = new Set();
	let reachable = true;

	const server = net.createServer((socket) => {
		if (!reachable) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));

		let buffer = "";
		let nick = "*";

		const write = (line) => {
			if (!socket.destroyed) {
				socket.write(`${line}\r\n`);
			}
		};

		const handle = (line) => {
			const separator = line.indexOf(" :");
			const head = (separator < 0 ? line : line.slice(0, separator))
				.split(" ")
				.filter(Boolean);
			const trailing = separator < 0 ? "" : line.slice(separator + 2);
			const command = (head[0] || "").toUpperCase();

			if (command === "NICK") {
				nick = head[1] || nick;
			} else if (command === "CAP") {
				const subcommand = (head[1] || "").toUpperCase();
				if (subcommand === "LS") {
					write(":fake.ergo CAP * LS :sasl");
				} else if (subcommand === "REQ") {
					write(":fake.ergo CAP * ACK :sasl");
				} else if (subcommand === "END") {
					write(`:fake.ergo 001 ${nick} :Welcome to the fake network`);
				}
			} else if (command === "AUTHENTICATE") {
				if ((head[1] || "") === "PLAIN") {
					write("AUTHENTICATE +");
					return;
				}
				const parts = Buffer.from(head[1] || "", "base64")
					.toString("utf8")
					.split("\0");
				const account = (parts[1] || "").toLowerCase();
				write(
					parts.length === 3 && registry.get(account) === parts[2]
						? `:fake.ergo 903 ${nick} :SASL authentication successful`
						: `:fake.ergo 904 ${nick} :SASL authentication failed`
				);
			} else if (command === "OPER") {
				write(
					head[1] === operName && head[2] === operPassword
						? `:fake.ergo 381 ${nick} :You are now an IRC operator`
						: `:fake.ergo 464 ${nick} :Password incorrect`
				);
			} else if (command === "JOIN") {
				write(`:${nick}!user@fake JOIN ${head[1] || "#unknown"}`);
			} else if (
				command === "PRIVMSG" &&
				(head[1] || "").toUpperCase() === "NICKSERV"
			) {
				const request = trailing.split(" ").filter(Boolean);
				const verb = (request[0] || "").toUpperCase();
				if (verb === "SAREGISTER") {
					const account = request[1] || "";
					const password = request[2] || "";
					registrations.push({account, password});
					if (registry.has(account.toLowerCase())) {
						write(
							`:NickServ!services@fake.ergo NOTICE ${nick} :Account ${account} already exists`
						);
					} else {
						registry.set(account.toLowerCase(), password);
						write(
							`:NickServ!services@fake.ergo NOTICE ${nick} :Successfully registered account ${account}`
						);
					}
				} else if (verb === "SUSPEND") {
					const account = request[2] || "";
					suspensions.push(account);
					write(
						`:NickServ!services@fake.ergo NOTICE ${nick} :Account ${account} suspended successfully`
					);
				}
			} else if (
				command === "PRIVMSG" &&
				(head[1] || "").toUpperCase() === "CHANSERV"
			) {
				const request = trailing.split(" ").filter(Boolean);
				if ((request[0] || "").toUpperCase() === "REGISTER") {
					const channel = (request[1] || "#unknown").toLowerCase();
					if (channels.has(channel)) {
						write(
							`:ChanServ!services@fake.ergo NOTICE ${nick} :Channel ${request[1]} is already registered`
						);
					} else {
						channels.add(channel);
						write(
							`:ChanServ!services@fake.ergo NOTICE ${nick} :Channel ${request[1] || "#unknown"} successfully registered`
						);
					}
				} else if ((request[0] || "").toUpperCase() === "AMODE") {
					amodes.push({
						channel: request[1] || "",
						mode: request[2] || "",
						account: request[3] || "",
					});
					write(
						`:ChanServ!services@fake.ergo NOTICE ${nick} :Added persistent mode ${request[2] || ""} on ${request[3] || ""}`
					);
				} else if ((request[0] || "").toUpperCase() === "TOPIC") {
					write(
						`:ChanServ!services@fake.ergo NOTICE ${nick} :Topic updated`
					);
				}
			} else if (command === "TOPIC") {
				topics.push({channel: head[1] || "", topic: trailing});
				write(`:${nick}!user@fake TOPIC ${head[1] || "#unknown"} :${trailing}`);
			} else if (command === "QUIT") {
				socket.destroy();
			}
		};

		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const index = buffer.indexOf("\n");
				if (index < 0) {
					break;
				}
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				try {
					handle(line);
				} catch {
					// A malformed command is dropped, as a real server would.
				}
			}
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				accounts: registry,
				registrations,
				suspensions,
				amodes,
				topics,
				setReachable(value) {
					reachable = value;
				},
				close() {
					for (const socket of sockets) {
						socket.destroy();
					}
					return new Promise((closed) => server.close(closed));
				},
			});
		});
	});
}

module.exports = {startFakeErgo};
