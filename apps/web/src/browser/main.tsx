import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { Workspace } from '../client/workspace.js';

const rootElement = document.getElementById('duya-web-root');
if (rootElement === null) {
  throw new Error('Duya workspace root element is missing from index.html');
}

const workspace = new Workspace();

const root = createRoot(rootElement);
root.render(<App workspace={workspace} />);
