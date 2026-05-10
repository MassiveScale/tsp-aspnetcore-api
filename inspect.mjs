import * as t from '@typespec/compiler';
const keys = Object.keys(t);
console.log('--- namespace/global keys ---');
console.log(keys.filter(k => k.toLowerCase().includes('namespace') || k.toLowerCase().includes('global')));
console.log('--- typeof createProgram ---');
console.log(typeof t.createProgram);
