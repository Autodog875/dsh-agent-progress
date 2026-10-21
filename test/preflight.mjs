// test/preflight.mjs — verify the client half against a stub module loader.
//   node test/preflight.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'lib', 'client.js');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const passed = [];
const failed = [];
const check = (name, fn) => {
  try {
    fn();
    passed.push(name);
  } catch (error) {
    failed.push(name + ' — ' + (error?.message ?? error));
  }
};

let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod; } } };
globalThis.document = {
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ textContent: '', remove() {} })
};

let importError = null;
try {
  await import(pathToFileURL(clientPath).href);
} catch (error) {
  importError = error;
}

check('模块可被导入', () => { if (importError) throw importError; });
check('顶层调用了 __ModuleLoader__.load', () => { if (loaded === null) throw new Error('load 从未被调用'); });
check('id 与包名一致', () => {
  if (loaded?.id !== pkg.name) throw new Error('id=' + JSON.stringify(loaded?.id) + ' 包名=' + pkg.name);
});
check('声明了 web 平台与 client 注入', () => {
  const client = pkg.dsh?.client;
  if (client?.platform !== 'web') throw new Error('dsh.client.platform 必须是 web');
  if (!Array.isArray(client?.inject) || client.inject.length === 0) throw new Error('dsh.client.inject 不能为空');
});
check('package.json 暴露了 ./client 入口', () => {
  if (pkg.exports?.['./client'] === undefined) throw new Error('exports["./client"] 缺失');
});

// ── minimal React stub: enough to run the module body and one render ─────────
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn
};

const registrations = [];
const effects = [];
const ctx = {
  connection: { rpc: { call: async () => ({ ok: true, value: { tasks: [] } }) } },
  effect: (fn, label) => { const dispose = fn(); effects.push({ label, dispose }); return dispose; },
  slots: {
    inject: (name, factory) => factory(),
    register: (meta, component) => { registrations.push({ meta, component }); return () => {}; }
  }
};

const exports_ = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

function collectText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (typeof node === 'object' && Array.isArray(node.children)) return collectText(node.children);
  if (typeof node === 'object' && node.props) return collectText(node.props.children);
  return '';
}

check('factory 返回 exports', () => { if (typeof exports_ !== 'object') throw new Error('not an object'); });
check('exports.apply 是函数', () => { if (typeof exports_.apply !== 'function') throw new Error('apply missing'); });
check('exports.inject 是数组', () => { if (!Array.isArray(exports_.inject)) throw new Error('inject missing'); });
check('apply(ctx) 不抛', () => { exports_.apply(ctx); });
check('注册到会话头部槽位', () => {
  const row = registrations.find((item) => item.meta?.name === 'conversation.session.header.actions');
  if (row === undefined) throw new Error('没有注册到 conversation.session.header.actions');
  if (typeof row.component !== 'function') throw new Error('组件不是函数');
});
check('无任务时显示"无任务"占位', () => {
  const row = registrations[0];
  const tree = row.component({ sessionId: 'session-test' });
  if (tree === null) throw new Error('进度条应常驻，不应返回 null');
  const text = collectText(tree);
  if (!text.includes('无任务')) throw new Error('缺少"无任务"占位，实际: ' + text);
});

for (const name of passed) console.log('ok   ' + name);
for (const line of failed) console.error('FAIL ' + line);
console.log('');
console.log(failed.length === 0 ? 'ALL PASS (' + passed.length + ')' : failed.length + ' 项不通过');
process.exit(failed.length === 0 ? 0 : 1);
