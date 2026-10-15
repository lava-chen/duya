import type {
  GatewayMessageMirrorInput,
  HostLocalGatewayMessageMirrorApiV1,
} from '@duya/agent-protocol/gateway-message-mirror';
import type { GatewayMessageMirrorStore } from '@duya/data/gateway-message-mirror-store';

export function createHostLocalGatewayMessageMirrorApi(
  store: GatewayMessageMirrorStore,
): HostLocalGatewayMessageMirrorApiV1 {
  return {
    async appendGatewayMessageMirror(input: GatewayMessageMirrorInput) {
      return store.append(input);
    },
  };
}
