import { bootstrap } from './bootstrap';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Game host is missing');
let dispose: (() => void) | undefined;
let replaced = false;
const controller=new AbortController();
void bootstrap(app,controller.signal).then(cleanup => { if (replaced) cleanup(); else dispose = cleanup; });
if (import.meta.hot) import.meta.hot.dispose(() => { replaced = true; controller.abort(); dispose?.(); });
