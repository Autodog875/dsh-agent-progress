const mod = await import('./_copy-index.js');
const svc = Object.create(mod.AgentProgressService.prototype);
svc.root = 'C:/Users/13001/.dsh/agent-progress';
const own = await svc.state({ sessionId: 'session-does-not-exist' });
console.log('empty session ->', JSON.stringify(own.tasks));
const g = await svc.state({ sessionId: 'session-does-not-exist', global: true });
console.log('global ->', g.tasks.map(t => `${t.key}:${t.status}:${t.done}/${t.total}${t.unit}${t.foreign ? ':foreign' : ''}`).join(' | ') || '(none)');