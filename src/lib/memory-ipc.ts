import type { WikiNode, WikiIndexEntry, WikiLogEntry } from '@/types/memory';

export async function listAllNodesIPC(): Promise<WikiIndexEntry[]> {
  return window.electronAPI!.wiki.listAllNodes();
}

export async function getNodeIPC(nodePath: string): Promise<WikiNode | null> {
  return window.electronAPI!.wiki.getNode(nodePath);
}

export async function updateNodeIPC(node: WikiNode): Promise<boolean> {
  return window.electronAPI!.wiki.updateNode(node);
}

export async function deleteNodeIPC(nodePath: string): Promise<boolean> {
  return window.electronAPI!.wiki.deleteNode(nodePath);
}

export async function searchNodesIPC(query: string): Promise<WikiIndexEntry[]> {
  return window.electronAPI!.wiki.searchNodes(query);
}

export async function readIndexIPC(): Promise<WikiIndexEntry[]> {
  return window.electronAPI!.wiki.readIndex();
}

export async function readLogIPC(): Promise<WikiLogEntry[]> {
  return window.electronAPI!.wiki.readLog();
}

export async function listInboxFilesIPC(): Promise<string[]> {
  return window.electronAPI!.wiki.listInboxFiles();
}

export async function readInboxFileIPC(filename: string): Promise<string | null> {
  return window.electronAPI!.wiki.readInboxFile(filename);
}

export async function deleteInboxFileIPC(filename: string): Promise<boolean> {
  return window.electronAPI!.wiki.deleteInboxFile(filename);
}

export async function getWikiRootPathIPC(): Promise<string> {
  return window.electronAPI!.wiki.getRootPath();
}