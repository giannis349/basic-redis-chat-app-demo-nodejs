// @ts-check
const bcrypt = require('bcrypt');
const { json } = require('body-parser');
const { incr, set, hmset, sadd, hmget, exists, uset, hgetall, rpush, get,
  client: redisClient,
} = require('./redis');

/** Redis key for the username (for getting the user id) */
const makeUsernameKey = (username) => {
  const usernameKey = `username:${username}`;
  return usernameKey;
};

const makeUseridKey = (userid) => {
  const useridKey = `userid:${userid}`;
  return useridKey;
};

/**
 * Creates a user and adds default chat rooms
 * @param {string} username 
 * @param {string} password 
 * @param {Number} role 
 * @param {string} userid
 */
const createUser = async (username, userid, password, role) => {
  const usernameKey = makeUsernameKey(username);
  const useridKey = makeUseridKey(userid);
  /** Create user */
  const hashedPassword = await bcrypt.hash(password, 10);
  const nextId = await incr("total_users");
  const userKey = `users:${userid}`;
  const roleKey = `role:${role}`
  // const useridKey = `userid:${userid}`
  await uset(usernameKey, userKey, roleKey, useridKey);
  await hmset(userKey, ["username", username, "password", hashedPassword, "role", roleKey, "userid", useridKey]);
  await sadd("allusers", userid);

  /**
   * Each user has a set of rooms he is in
   * let's define the default ones
   */
  await sadd(`users:${userid}:rooms`, `${0}`); // Main room

  /** This one should go to the session */
  return { id: userid, username, role, userid };
};

const getPrivateRoomId = (user1, user2) => {
  if (isNaN(user1) || isNaN(user2) || user1 === user2) {
    return null;
  }
  const minUserId = user1 > user2 ? user2 : user1;
  const maxUserId = user1 > user2 ? user1 : user2;
  return `${minUserId}:${maxUserId}`;
};

/**
 * Create a private room and add users to it
 * @returns {Promise<[{
 *  id: string;
 *  names: any[];
 * }, boolean]>}
 */
const createPrivateRoom = async (user1, user2) => {
  const roomId = getPrivateRoomId(user1, user2);

  if (roomId === null) {
    return [null, true];
  }

  /** Add rooms to those users */
  await sadd(`user:${user1}:rooms`, `${roomId}`);
  await sadd(`user:${user2}:rooms`, `${roomId}`);

  return [{
    id: roomId,
    names: [
      await hmget(`user:${user1}`, "username"),
      await hmget(`user:${user2}`, "username"),
    ],
  }, false];
};

/**
 * Create a private room and add users to it
 * @returns {Promise<[{
 *  id: string;
 *  names: any[];
 *  subchannels: any[];
 * }, boolean]>}
 */
const createPrivateChannel = async (data) => {
  console.log('data', data)
  const userid = data.userid
  const roomId = String(data.channelname);
  const l = data.users.length
  console.log('l', l, roomId)
  let allnames = []
  if (roomId === null) {
    return [null, true];
  }

  for (let index = 0; index < data.users.length; index++) {
    const element = data.users[index];
    console.log('element', element)
    let i = element
    const id = String(i);
    const userExists = await exists(`users:${id}`);
    if (userExists) {
      let j = JSON.stringify(data)
      await sadd(`users:${id}:rooms`, `${j}`);
      let aname = await hgetall(`users:${id}`);
      console.log('addname', aname)
      allnames.push({username: aname.username, userid: id})
      console.log('allnames', allnames)
      
    } else {
      console.log('User not exist')
    }
  }

  /** Add rooms to those users */
  // await sadd(`user:${user1}:rooms`, `${roomId}`);
  // await sadd(`user:${user2}:rooms`, `${roomId}`);

  return [{
    id: roomId,
    names: allnames,
    subchannels: []
  }, false];
};

const getMessages = async (roomId = "0", offset = 0, size = 50, usertoreset = "") => {
  /**
   * Logic:
   * 1. Check if room with id exists
   * 2. Fetch messages from last hour
   **/
  const roomKey = `room:${roomId}`;
  const roomExists = await exists(roomKey);
  if (!roomExists) {
    return [];
  } else {
    return new Promise((resolve, reject) => {
      redisClient.zrevrange(roomKey, offset, offset + size, (err, values) => {
        if (err) {
          reject(err);
        }
        resolve(values.map((val) => JSON.parse(val)));
      });
    });
  }
};

const getMoreMessages = async (roomId, offset, size) => {
  console.log('getMoreMessages', roomId, offset, size)
  /**
   * Logic:
   * 1. Check if room with id exists
   * 2. Fetch messages from last hour
   **/
  const roomKey = `room:${roomId}`;
  const roomExists = await exists(roomKey);
  if (!roomExists) {
    return [];
  } else {
    return new Promise((resolve, reject) => {
      redisClient.zrevrange(roomKey, offset, offset + size, (err, values) => {
        if (err) {
          reject(err);
        }
        resolve(values.map((val) => JSON.parse(val)));
      });
    });
  }
};

const sanitise = (text) => {
  let sanitisedText = text;

  if (text.indexOf('<') > -1 || text.indexOf('>') > -1) {
    sanitisedText = text.replace(/</g, '&lt').replace(/>/g, '&gt');
  }

  return sanitisedText;
};

module.exports = {
  getMessages,
  getMoreMessages,
  sanitise,
  createUser,
  makeUsernameKey,
  makeUseridKey,
  createPrivateRoom,
  createPrivateChannel,
  getPrivateRoomId
};