const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/wordmaster.db');

// Fix remaining text issues from corruption
const fixes = [
  { table: 'exam_paragraphs', id: 178, search: 'any will do well', replace: 'Many will do well' },
  { table: 'exam_paragraphs', id: 178, search: '. U But', '. But' },
  { table: 'exam_paragraphs', id: 185, search: 'teaching U students', replace: 'teaching students' },
  { table: 'exam_paragraphs', id: 185, search: 'whether O they', replace: 'whether they' },
  { table: 'exam_paragraphs', id: 207, search: 'toY pile', replace: 'to pile' },
];

let totalFixed = 0;
fixes.forEach(f => {
  const row = db.prepare('SELECT ' + (f.table === 'exam_paragraphs' ? 'text' : 'passage') + ' FROM ' + f.table + ' WHERE id = ?').get(f.id);
  if (!row) return;
  const col = f.table === 'exam_paragraphs' ? 'text' : 'passage';
  if (row[col] && row[col].includes(f.search)) {
    const newText = row[col].replace(f.search, f.replace);
    db.prepare('UPDATE ' + f.table + ' SET ' + col + ' = ? WHERE id = ?').run(newText, f.id);
    totalFixed++;
    console.log('Fixed ' + f.table + '.' + f.id + ': "' + f.search + '" -> "' + f.replace + '"');
  }
});

console.log('\nTotal text fixes:', totalFixed);
