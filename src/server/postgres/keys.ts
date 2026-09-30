import type { KeyObject } from 'node:crypto';
/** KMS/key custody stays outside the SDK. Rotation retains old decrypt handles. */
export interface AgentStateKeys {
  current(): Promise<{ ref: string; key: KeyObject }>;
  resolve(ref: string): Promise<KeyObject>;
}
