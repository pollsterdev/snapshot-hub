import { getAddress } from '@ethersproject/address';
import snapshot from '@snapshot-labs/snapshot.js';
import fleek from '@fleekhq/fleek-storage-js';
import db from '../mysql';
import { spaceIdsFailed, spaces } from '../spaces';

export async function addOrUpdateSpace(space: string, settings: any) {
  if (!settings || !settings.name) return false;
  const ts = (Date.now() / 1e3).toFixed();
  const query =
    'INSERT IGNORE INTO spaces SET ? ON DUPLICATE KEY UPDATE updated_at = ?, settings = ?';
  await db.queryAsync(query, [
    {
      id: space,
      created_at: ts,
      updated_at: ts,
      settings: JSON.stringify(settings)
    },
    ts,
    JSON.stringify(settings)
  ]);
}

export async function loadSpace(id) {
  let space = false;
  try {
    const result = await getSpace(id);
    if (snapshot.utils.validateSchema(snapshot.schemas.space, result))
      space = result;
    console.log('Load space', id);
  } catch (e) {
    console.log('Load space failed', id);
  }
  return space;
}

export async function storeProposal(space, body, id, relayerIpfsHash) {
  const msg = JSON.parse(body.msg);
  const query = 'INSERT IGNORE INTO messages SET ?;';
  await db.queryAsync(query, [
    {
      id,
      address: body.address,
      version: msg.version,
      timestamp: msg.timestamp,
      space,
      type: 'proposal',
      payload: JSON.stringify(msg.payload),
      sig: body.sig,
      metadata: JSON.stringify({
        relayer_ipfs_hash: relayerIpfsHash
      })
    }
  ]);

  /* Store the proposal in dedicated table 'proposals' */
  const spaceSettings = spaces[space];
  const author = getAddress(body.address);
  const created = parseInt(msg.timestamp);
  const metadata = msg.payload.metadata || {};
  const strategies = JSON.stringify(
    metadata.strategies || spaceSettings.strategies
  );
  const plugins = JSON.stringify(metadata.plugins || {});
  const network = metadata.network || spaceSettings.network;
  const proposalSnapshot = parseInt(msg.payload.snapshot || '0');

  const params = {
    id,
    author,
    created,
    space,
    network,
    type: msg.payload.type || 'single-choice',
    strategies,
    plugins,
    title: msg.payload.name,
    body: msg.payload.body,
    choices: JSON.stringify(msg.payload.choices),
    start: parseInt(msg.payload.start || '0'),
    end: parseInt(msg.payload.end || '0'),
    snapshot: proposalSnapshot || 0
  };

  await db.queryAsync('INSERT IGNORE INTO proposals SET ?', params);
  console.log('Store proposal complete', space, id);
}

export async function storeVote(space, body, id, relayerIpfsHash) {
  const msg = JSON.parse(body.msg);
  const query = 'INSERT IGNORE INTO messages SET ?;';
  await db.queryAsync(query, [
    {
      id,
      address: body.address,
      version: msg.version,
      timestamp: msg.timestamp,
      space,
      type: 'vote',
      payload: JSON.stringify(msg.payload),
      sig: body.sig,
      metadata: JSON.stringify({
        relayer_ipfs_hash: relayerIpfsHash
      })
    }
  ]);

  /* Store the vote in dedicated table 'votes' */
  const params = {
    id,
    voter: getAddress(body.address),
    created: parseInt(msg.timestamp),
    space,
    proposal: msg.payload.proposal,
    choice: JSON.stringify(msg.payload.choice),
    metadata: JSON.stringify(msg.payload.metadata || {})
  };

  await db.queryAsync('INSERT IGNORE INTO votes SET ?', params);
  console.log('Store vote complete', space, id);
}

const getSpace = async ({ id }) => {
  const query = `
    SELECT *
    FROM spaces
    WHERE id = ?
  `

  const [space] = await db.queryAsync(query, [id])

  return space
}

export async function storeSettings(space, body) {
  const msg = JSON.parse(body.msg);

  const key = `registry/${body.address}/${space}`;
  const result = await fleek.upload({
    apiKey: process.env.FLEEK_API_KEY || '',
    apiSecret: process.env.FLEEK_API_SECRET || '',
    bucket: process.env.FLEEK_API_BUCKET,
    key,
    data: JSON.stringify(msg.payload)
  });
  const ipfsHash = result.hashV0;
  console.log('Settings updated', space, ipfsHash);

  const spaceFromDb = await getSpace({ id: space.id })
  if (spaceFromDb) space.approved = spaceFromDb.approved || false

  await addOrUpdateSpace(space, msg.payload);
}

export async function getActiveProposals() {
  const ts = parseInt((Date.now() / 1e3).toFixed());
  const query = `
    SELECT space, COUNT(id) AS count FROM proposals
    WHERE start < ? AND end > ?
    GROUP BY space
  `;
  return await db.queryAsync(query, [ts, ts]);
}

export async function loadSpaces() {
  console.time('loadSpaces');
  const query = 'SELECT id FROM spaces';
  let result = [];
  try {
    result = await db.queryAsync(query);
  } catch (e) {
    console.log(e);
  }
  const ids = result.map((space: any) => space.id);
  console.log('Spaces from db', ids.length);
  const _spaces = {};
  const max = 25;
  const pages = Math.ceil(ids.length / max);
  for (let i = 0; i < pages; i++) {
    const pageIds = ids.slice(max * i, max * (i + 1));
    const pageSpaces = await Promise.all(pageIds.map(id => loadSpace(id)));
    pageIds.forEach((id, index) => {
      if (pageSpaces[index]) {
        _spaces[id] = pageSpaces[index];
        addOrUpdateSpace(id, pageSpaces[index]);
      } else {
        spaceIdsFailed.push(id);
      }
    });
  }
  console.timeEnd('loadSpaces');
  return _spaces;
}

export async function resolveContent(provider, name) {
  const contentHash = await snapshot.utils.resolveENSContentHash(
    name,
    provider
  );
  return snapshot.utils.decodeContenthash(contentHash);
}

export async function getProposal(space, id) {
  const query = `SELECT * FROM messages WHERE space = ? AND id = ? AND type = 'proposal'`;
  const proposals = await db.queryAsync(query, [space, id]);
  return proposals[0];
}
