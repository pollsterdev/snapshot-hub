import { getActiveProposals } from './adapters/mysql';
import db from './mysql';

export let spaces = {};

export const spaceIdsFailed: string[] = [];

setInterval(() => {
  getActiveProposals().then((result: any) =>
    result.forEach(count => {
      if (spaces[count.space]) {
        spaces[count.space]._activeProposals = count.count;
      }
    })
  );
}, 20e3);

const dbSpaceResultToEntry = (ensSpace: any) => {
  const entry = [ensSpace.id, JSON.parse(ensSpace.settings)]
  entry[1].approved = ensSpace.approved
  return entry
}

export const getSpaces = async () => {
  console.log('Load spaces from db');

  const query = `
    SELECT id, settings, approved
    FROM spaces
    WHERE settings IS NOT NULL
    ORDER BY id ASC`;

  const dbSpaces = await db.queryAsync(query)
  return Object.fromEntries(dbSpaces.map(dbSpaceResultToEntry))
}

setTimeout(() => {
  getSpaces()
    .then(result => {
      spaces = result

      const totalSpaces = Object
        .keys(spaces)
        .length;

      const totalPublicSpaces = Object
        .values(spaces)
        .filter((space: any) => !space.private)
        .length;

      console.log('Total spaces', totalSpaces);
      console.log('Total public spaces', totalPublicSpaces);
    });
}, 2e3);
