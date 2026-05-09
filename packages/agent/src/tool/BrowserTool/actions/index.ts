import { navigateAction, goBackAction } from './navigation.js';
import { snapshotAction } from './snapshot.js';
import { clickAction, typeAction, scrollAction, pressKeyAction, hoverAction, waitAction } from './interaction.js';
import { evaluateAction, iframeEvaluateAction } from './evaluate.js';
import { screenshotAction } from './screenshot.js';
import { tabsListAction, tabsNewAction, tabsCloseAction, tabsSelectAction } from './tabs.js';
import { fileUploadAction, selectAction } from './forms.js';
import { networkStartAction, networkReadAction } from './network.js';
import { cookiesAction } from './cookies.js';
import { parallelFetchAction, browserParallelAction } from './parallel.js';
import { closeWindowAction } from './close.js';
import type { ActionHandler } from './types.js';

export { type ActionContext, type ActionHandler, type ActionResult } from './types.js';
export { SchemaGenerator } from '../SchemaGenerator.js';
export { ActionRegistry } from './ActionRegistry.js';

export {
  navigateAction,
  snapshotAction,
  clickAction,
  typeAction,
  scrollAction,
  screenshotAction,
  evaluateAction,
  goBackAction,
  pressKeyAction,
  hoverAction,
  waitAction,
  selectAction,
  parallelFetchAction,
  browserParallelAction,
  tabsListAction,
  tabsNewAction,
  tabsCloseAction,
  tabsSelectAction,
  fileUploadAction,
  networkStartAction,
  networkReadAction,
  iframeEvaluateAction,
  cookiesAction,
  closeWindowAction,
};

const ALL_ACTIONS: ActionHandler[] = [
  navigateAction,
  snapshotAction,
  clickAction,
  typeAction,
  scrollAction,
  screenshotAction,
  evaluateAction,
  goBackAction,
  pressKeyAction,
  hoverAction,
  waitAction,
  selectAction,
  parallelFetchAction,
  browserParallelAction,
  tabsListAction,
  tabsNewAction,
  tabsCloseAction,
  tabsSelectAction,
  fileUploadAction,
  networkStartAction,
  networkReadAction,
  iframeEvaluateAction,
  cookiesAction,
  closeWindowAction,
];

export function getAllActions(): ActionHandler[] {
  return ALL_ACTIONS;
}
