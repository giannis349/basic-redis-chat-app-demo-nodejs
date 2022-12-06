// @ts-check
const express = require("express");
const bcrypt = require("bcrypt");
const session = require("express-session");
const bodyParser = require("body-parser");
const cors = require("cors");
/** @ts-ignore */
const randomName = require("node-random-name");
let RedisStore = require("connect-redis")(session);
const path = require("path");
const fs = require("fs").promises;

const {
  client: redisClient,
  exists,
  set,
  get,
  getset,
  hgetall,
  scan,
  sadd,
  rpush,
  zadd,
  hmget,
  smembers,
  sismember,
  srem,
  sub,
  auth: runRedisAuth,
} = require("./redis");
const {
  createUser,
  makeUsernameKey,
  createPrivateRoom,
  createPrivateChannel,
  sanitise,
  getMessages,
  getChannels,
} = require("./utils");
const { createDemoData } = require("./demo-data");
const { PORT, SERVER_ID } = require("./config");
const { json } = require("body-parser");

const app = express();
app.use(cors());
const server = require("http").createServer(app, {
  cors: {
    origin: [
      "http://localhost:8080",
      "http://localhost:3000",
      "http://localhost:8081",
      "capacitor://localhost",
      "http://localhost/",
      "http://localhost",
    ],
  },
});

/** @type {SocketIO.Server} */
const io =
  /** @ts-ignore */
  require("socket.io")(server, {
    cors: {
      origin: "*"
    }
  });

const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: "keyboard cat",
  saveUninitialized: true,
  resave: true,
});

const auth = (req, res, next) => {
  if (!req.session.user) {
    return res.sendStatus(403);
  }
  next();
};

const publish = (type, data) => {
  const outgoing = {
    serverId: SERVER_ID,
    type,
    data,
  };
  redisClient.publish("MESSAGES", JSON.stringify(outgoing));
};

const initPubSub = () => {
  /** We don't use channels here, since the contained message contains all the necessary data. */
  sub.on("message", (_, message) => {
    /**
     * @type {{
     *   serverId: string;
     *   type: string;
     *   data: object;
     * }}
     **/
    const { serverId, type, data } = JSON.parse(message);
    /** We don't handle the pub/sub messages if the server is the same */
    if (serverId === SERVER_ID) {
      return;
    }
    io.emit(type, data);
  });
  sub.subscribe("MESSAGES");
};

/** Initialize the app */
(async () => {
  /** Need to submit the password from the local stuff. */
  await runRedisAuth();
  /** We store a counter for the total users and increment it on each register */
  const totalUsersKeyExist = await exists("total_users");
  if (!totalUsersKeyExist) {
    /** This counter is used for the id */
    await set("total_users", 0);
    /**
     * Some rooms have pre-defined names. When the clients attempts to fetch a room, an additional lookup
     * is handled to resolve the name.
     * Rooms with private messages don't have a name
     */
    await set(`room:${0}:name`, "Announcements");

    /** Create demo data with the default users */
    await createDemoData();
  }

  /** Once the app is initialized, run the server */
  runApp();
})();

async function runApp() {
  const repoLinks = await fs
    .readFile(path.dirname(__dirname) + "/repo.json")
    .then((x) => JSON.parse(x.toString()));

  app.use(bodyParser.json());
  app.use("/", express.static(path.dirname(__dirname) + "/client/build"));

  initPubSub();

  /** Store session in redis. */
  app.use(sessionMiddleware);
  io.use((socket, next) => {
    /** @ts-ignore */
    sessionMiddleware(socket.request, socket.request.res || {}, next);
    // sessionMiddleware(socket.request, socket.request.res, next); will not work with websocket-only
    // connections, as 'socket.request.res' will be undefined in that case
  });

  app.get("/links", (req, res) => {
    return res.send(repoLinks);
  });
  let adduser = null
  io.on("connection", async (socket) => {
    if (adduser) {
      socket.request.session.user = adduser
    }
    
    console.log('connection', socket.request.session.user)
    if (socket.request.session.user === undefined) {
      return;
    }
    const userId = socket.request.session.user.id;
    await sadd("online_users", userId);

    const msg = {
      ...socket.request.session.user,
      online: true,
    };

    publish("user.connected", msg);
    socket.broadcast.emit("user.connected", msg);

    socket.on("room.join", (id) => {
      console.log('room.join', id)
      socket.join(`room:${id}`);
    });

    socket.on(
      "message",
      /**
       * @param {{
       *  from: string
       *  userid: string
       *  date: string
       *  message: string
       *  roomId: string
       * }} message
       **/
      async (message) => {
        console.log('message', message)
        /** Make sure nothing illegal is sent here. */
        message = { ...message, message: sanitise(message.message) };
        /**
         * The user might be set as offline if he tried to access the chat from another tab, pinging by message
         * resets the user online status
         */
        await sadd("online_users", message.from);
        /** We've got a new message. Store it in db, then send back to the room. */
        const messageString = JSON.stringify(message);
        const roomKey = `room:${message.roomId}`;
        /**
         * It may be possible that the room is private and new, so it won't be shown on the other
         * user's screen, check if the roomKey exist. If not then broadcast message that the room is appeared
         */
        // const isPrivate = !(await exists(`${roomKey}:name`));
        // const roomHasMessages = await exists(roomKey);
        // if (isPrivate && !roomHasMessages) {
        //   const ids = message.roomId.split(":");
        //   const msg = {
        //     id: message.roomId,
        //     names: [
        //       await hmget(`user:${ids[0]}`, "username"),
        //       await hmget(`user:${ids[1]}`, "username"),
        //     ],
        //   };
        //   publish("show.room", msg);
        //   socket.broadcast.emit(`show.room`, message);
        // }
        await zadd(roomKey, "" + message.date, messageString);
        // publish("messages", messageString);
        await rpush("messages", messageString);
        let d = String(message.date)
        await set(`users:${message.roomId}:${message.userid}:lastmessage`, d),
        console.log('message_bottom', message)
        io.to(roomKey).emit("message", message);
      }
    );

    socket.on("disconnect", async () => {
      const userId = socket.request.session.user.id;
      await srem("online_users", userId);
      const msg = {
        ...socket.request.session.user,
        online: false,
      };
      publish("user.disconnected", msg);
      socket.broadcast.emit("user.disconnected", msg);
    });
  });

  /** Fetch a randomly generated name so users don't have collisions when registering a new user. */
  app.get("/randomname", (_, res) => {
    return res.send(randomName({ first: true }));
  });

  /** The request the client sends to check if it has the user is cached. */
  app.get("/me", (req, res) => {
    /** @ts-ignore */
    const { user } = req.session;
    if (user) {
      return res.json(user);
    }
    /** User not found */
    return res.json(null);
  });

  /** Login/register login */
  app.post("/login", async (req, res) => {
    const { username, password, userid } = req.body;
    const userExists = await exists(`users:${userid}`);
    if (!userExists) {
      return res.status(404).json({ message: " User not found" });
    } else {
      const data = await hgetall(`users:${userid}`);
      if (await bcrypt.compare(password, data.password)) {
        console.log('data', data)
        const user = { id: data.userid.split(":").pop(), username, role: data.role.split(":").pop()};
        /** @ts-ignore */
        req.session.user = user;
        adduser = user
        console.log('req.session', req.session)
        return res.status(200).json(user);
      }
    }
    return res.status(404).json({ message: "Invalid username or password" });
  });

  app.post("/logout", auth, (req, res) => {
    req.session.destroy(() => {});
    return res.sendStatus(200);
  });

  /**
   * Create a private room and add users to it
   */
  app.post("/room", async (req, res) => {
    console.log('rom', req.body.user1)
    const { user1, user2 } = {
      user1: parseInt(req.body.user1),
      user2: parseInt(req.body.user2),
    };

    const [result, hasError] = await createPrivateRoom(user1, user2);
    if (hasError) {
      return res.sendStatus(400);
    }
    return res.status(200).send(result);
  });

  /** Fetch messages from the general chat (just to avoid loading them only once the user was logged in.) */
  app.get("/room/0/preload", async (req, res) => {
    const roomId = "0";
    try {
      let name = await get(`room:${roomId}:name`);
      const messages = await getMessages(roomId, 0, 20);
      return res.status(200).send({ id: roomId, name, messages });
    } catch (err) {
      return res.status(400).send(err);
    }
  });

  /** Fetch messages from a selected room */
  app.get("/room/:id/messages", async (req, res) => {
    console.log('room_maessages_id', req.params.id, +req.query.offset, +req.query.size)
    const roomId = req.params.id;
    const offset = +req.query.offset;
    const size = +req.query.size;
    try {
      const messages = await getMessages(roomId, offset, size);
      return res.status(200).send(messages);
    } catch (err) {
      return res.status(400).send(err);
    }
  });

  /** Check which users are online. */
  app.get(`/users/online`, auth, async (req, res) => {
    const onlineIds = await smembers(`online_users`);
    const users = {};
    for (let onlineId of onlineIds) {
      const user = await hgetall(`user:${onlineId}`);
      users[onlineId] = {
        id: onlineId,
        username: user.username,
        online: true,
      };
    }
    return res.send(users);
  });

  /** Retrieve the user info based on ids sent */
  app.get(`/users`, async (req, res) => {
    /** @ts-ignore */
    /** @type {string[]} */ const ids = req.query.ids;
    if (typeof ids === "object" && Array.isArray(ids)) {
      /** Need to fetch */
      const users = {};
      for (let x = 0; x < ids.length; x++) {
        /** @type {string} */
        const id = ids[x];
        const user = await hgetall(`user:${id}`);
        users[id] = {
          id: id,
          username: user.username,
          online: !!(await sismember("online_users", id)),
        };
      }
      return res.send(users);
    }
    return res.sendStatus(404);
  });

  /**
   * Get rooms for the selected user.
   * TODO: Add middleware and protect the other user info.
   */
  app.get(`/rooms/:userId`, async (req, res) => {
    const userId = req.params.userId;
    let id = String(userId)
    const myrooms = await smembers(`users:${id}:rooms`);
    res.status(200).send(myrooms);
  });

  app.get(`/myrooms/:userId`, async (req, res) => {
    const userId = req.params.userId;
    let id = String(userId)
    const myrooms = await smembers(`users:${id}:rooms`);
    res.status(200).send(myrooms);
  });

  app.post("/adduser", async (req, res) => {
    console.log('adduser', req.body)
    const { username, userid, password, role } = req.body;
    const usernameKey = makeUsernameKey(userid);
    const userExists = await exists(usernameKey);
    if (!userExists) {
      const newUser = await createUser(username, userid, password, role);
      /** @ts-ignore */
      req.session.user = newUser;
      return res.status(200).json(newUser);
    } else {
      return res.status(404).json({ message: " User exist" });
    }
  });

  app.get(`/getusers`, async (req, res) => {
    const allusers = await smembers("allusers");
    const users = [];
    for (let i = 0; i <= allusers.length; i++) {
      const id = String(allusers[i]);
      const userExists = await exists(`users:${id}`);
      if (userExists) {
        const user = await hgetall(`users:${id}`);
        users[i] = {
          id: id,
          username: user.username,
          role: user.role,
          userid: user.userid,
          online: !!(await sismember("online_users", id)),
        };
      } else {
        console.log('User not exist')
      }
        
    }
    return res.send(users);
  });

  app.post("/create_channel", async (req, res) => {
    console.log('rom', req.body)
    const data = req.body
    const [result, hasError] = await createPrivateChannel(data);
    if (hasError) {
      return res.sendStatus(400);
    }
    console.log('result', result)
    let str = JSON.stringify(result)
    await rpush("rooms", str);
    return res.status(200).send(result);

  });

  app.post("/lastmessage", async (req, res) => {
    console.log('lastmessage', req.body.roomids)
    let result = []
    const {roomids, userid} = req.body
    console.log('roomids.length', roomids.length)
    for (let index6 = 0; index6 < roomids.length; index6++) {
      const element = roomids[index6];
      let ls = await get(`users:${element.id}:${userid}:lastmessage`);
      let obj = {
        roomid: element.id,
        ls: ls
      }
      console.log('ls', ls)
      result.push(obj)
    }
    // let ls = await get(`users:${roomid}:${userid}:lastmessage`);
    // console.log('ls', ls)
    // result.push(ls)
    return res.status(200).send(result);

  });
  /**
   * We have an external port from the environment variable. To get this working on heroku,
   * it's required to specify the host
   */
  if (process.env.PORT) {
    server.listen(+PORT, "0.0.0.0", () =>
      console.log(`Listening on ${PORT}...`)
    );
  } else {
    server.listen(+PORT, () => console.log(`Listening on ${PORT}...`));
  }
}
