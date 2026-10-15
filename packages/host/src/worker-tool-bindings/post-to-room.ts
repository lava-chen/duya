/** Bind the capability to Host product services. */
import {
  PostToRoomTool as CapabilityPostToRoomTool,
  type PostToRoomPort,
} from '@duya/capabilities/post-to-room-tool';
import { createWorkerRoomMessagingPort } from '@duya/host/worker-tool-services/room-messaging';

export type {
  PostToRoomGroup,
  PostToRoomMessage,
  PostToRoomPort,
  ValidatedRoomTarget,
} from '@duya/capabilities/post-to-room-tool';

export class PostToRoomTool extends CapabilityPostToRoomTool {
  constructor(port: PostToRoomPort = createWorkerRoomMessagingPort()) {
    super(port);
  }
}

export const postToRoomTool = new PostToRoomTool();
