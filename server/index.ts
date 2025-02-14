global['fetch'] = require('node-fetch');
import express from 'express';
import { getAddress } from '@ethersproject/address';
import { spaces, getSpaces } from './helpers/spaces';
import db from './helpers/mysql';
import relayer from './helpers/relayer';
import { pinJson } from './helpers/ipfs';
import {
  verifySignature,
  jsonParse,
  sendError,
  hashPersonalMessage,
  formatMessage
} from './helpers/utils';
import { addOrUpdateSpace, loadSpace } from './helpers/adapters/mysql';
import writer from './writer';
import gossip from './helpers/gossip';
import pkg from '../package.json';

const router = express.Router();
const network = process.env.NETWORK || 'testnet';
const admins = (process.env.ADMINS)
  ? process.env.ADMINS.split(',')
  : []

router.get('/', (req, res) => {
  return res.json({
    name: pkg.name,
    network,
    version: pkg.version,
    tag: 'alpha',
    relayer: relayer.address
  });
});

router.get('/spaces/unapproved', async (req, res) => {
  try {
      const query = `
        SELECT *
        FROM spaces
        WHERE approved = false
      `

      const spaces = (await db.queryAsync(query))
        .map((x: any) => {
          x.settings = JSON.parse(x.settings)
          x.approved = Boolean(x.approved)
          return x
        })

      res.json(spaces)
  } catch (err) {
    console.error(err)
    res.status(500).send('Problem getting unapproved spaces')
  }
})

router.get('/spaces/:key?', async (req, res) => {
  try {
    const { key } = req.params
    const spacesFromDb = await getSpaces()
    return res.json(key ? spacesFromDb[key] : spacesFromDb)
  } catch (err) {
    console.error(err)
    res.status(500).send('Problem getting spaces')
  }
});

const pokeSpace = async ({ key }) => {
  const space = await loadSpace(key)
  if (space) {
    await addOrUpdateSpace(key, space)
    spaces[key] = space
  }

  return space
}

router.get('/spaces/:key/poke', async (req, res) => {
  const { key } = req.params
  const space = await pokeSpace({ key })
  return res.json(space)
})

router.get('/admins/:account', async (req, res) => {
  try {
    const account = req.params.account

    if (!account) res.send(false)

    res.send(admins.includes(account))
  } catch (err) {
    console.error(err)
    res.status(500).send('Unable to determine if admin')
  }
})

router.post('/spaces/:spaceId/approve', async (req, res) => {
  try {
    const { spaceId } = req.params
    const { account, message, signature } = req.body

    if (!admins.includes(account)) {
      return res.status(400).send('You are not an admin')
    }

    const isValidSignature = await verifySignature(account, signature, hashPersonalMessage(message))
    if (!isValidSignature) {
      return res.status(400).send('Invalid signature')
    }

    const query = `
      UPDATE spaces
      SET approved = true
      WHERE id = ?
    `

    await db.queryAsync(query, [spaceId])
    const spaceEntry: any = Object.entries(spaces)
      .filter(x => x[0] === spaceId)

    const space = spaceEntry[0]

    if (space && space[1]) space[1].approved = true

    res.json({ status: 'success' })
  } catch (err) {
    console.error(err)
    res.status(500).send('Problem approving space')
  }
})

router.get('/:space/proposals', async (req, res) => {
  const { space } = req.params;
  const query =
    "SELECT * FROM messages WHERE type = 'proposal' AND space = ? ORDER BY timestamp DESC LIMIT 100";
  db.queryAsync(query, [space]).then(messages => {
    res.json(
      Object.fromEntries(messages.map(message => formatMessage(message)))
    );
  });
});

router.get('/:space/proposal/:id', async (req, res) => {
  const { space, id } = req.params;
  const query = `
    SELECT v.* FROM votes v
    LEFT OUTER JOIN votes v2 ON
      v.voter = v2.voter AND v.proposal = v2.proposal
      AND ((v.created < v2.created) OR (v.created = v2.created AND v.id < v2.id))
    WHERE v2.voter IS NULL AND v.space = ? AND v.proposal = ?
    ORDER BY created ASC
  `;
  db.queryAsync(query, [space, id]).then(messages => {
    res.json(
      Object.fromEntries(
        messages.map(message => {
          const address = getAddress(message.voter);
          return [
            address,
            {
              address,
              msg: {
                timestamp: message.created.toString(),
                payload: {
                  choice: JSON.parse(message.choice),
                  metadata: JSON.parse(message.metadata),
                  proposal: message.proposal
                }
              },
              authorIpfsHash: message.id
            }
          ];
        })
      )
    );
  });
});

router.get('/voters', async (req, res) => {
  const { from = 0, to = 1e24 } = req.query;
  const spacesArr = req.query.spaces
    ? (req.query.spaces as string).split(',')
    : Object.keys(spaces);
  const query = `SELECT address, timestamp, space FROM messages WHERE type = 'vote' AND timestamp >= ? AND timestamp <= ? AND space IN (?) GROUP BY address ORDER BY timestamp DESC`;
  const messages = await db.queryAsync(query, [from, to, spacesArr]);
  res.json(messages);
});

router.post('/message', async (req, res) => {
  if (process.env.MAINTENANCE)
    return sendError(res, 'update in progress, try later');

  const body = req.body;
  const msg = jsonParse(body.msg);
  const ts = Date.now() / 1e3;
  const overTs = (ts + 300).toFixed();
  const underTs = (ts - 300).toFixed();

  if (!body || !body.address || !body.msg || !body.sig)
    return sendError(res, 'wrong message body');

  if (
    Object.keys(msg).length !== 5 ||
    !msg.space ||
    !msg.payload ||
    Object.keys(msg.payload).length === 0
  )
    return sendError(res, 'wrong signed message');

  if (JSON.stringify(body).length > 1e5)
    return sendError(res, 'too large message');

  if (!spaces[msg.space] && msg.type !== 'settings')
    return sendError(res, 'unknown space');

  if (
    !msg.timestamp ||
    typeof msg.timestamp !== 'string' ||
    msg.timestamp.length !== 10 ||
    msg.timestamp > overTs ||
    msg.timestamp < underTs
  )
    return sendError(res, 'wrong timestamp');

  if (!msg.version || msg.version !== pkg.version)
    return sendError(res, 'wrong version');

  if (!msg.type || !Object.keys(writer).includes(msg.type))
    return sendError(res, 'wrong message type');

  if (
    !(await verifySignature(
      body.address,
      body.sig,
      hashPersonalMessage(body.msg)
    ))
  )
    return sendError(res, 'wrong signature');

  try {
    await writer[msg.type].verify(body);
  } catch (e) {
    return sendError(res, e);
  }

  gossip(body, msg.space);

  const authorIpfsRes = await pinJson(`snapshot/${body.sig}`, {
    address: body.address,
    msg: body.msg,
    sig: body.sig,
    version: '2'
  });
  const relayerSig = await relayer.signMessage(authorIpfsRes);
  const relayerIpfsRes = await pinJson(`snapshot/${relayerSig}`, {
    address: relayer.address,
    msg: authorIpfsRes,
    sig: relayerSig,
    version: '2'
  });

  try {
    await writer[msg.type].action(body, authorIpfsRes, relayerIpfsRes);
  } catch (e) {
    return sendError(res, e);
  }

  console.log(
    `Address "${body.address}"\n`,
    `Space "${msg.space}"\n`,
    `Type "${msg.type}"\n`,
    `IPFS hash "${authorIpfsRes}"`
  );

  return res.json({
    ipfsHash: authorIpfsRes,
    relayer: {
      address: relayer.address,
      receipt: relayerIpfsRes
    }
  });
});

export default router;
