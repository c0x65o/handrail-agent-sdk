import * as sdk from 'handrail-agent-sdk';
import * as server from 'handrail-agent-sdk/server';

// Both namespaces are intentionally empty at this bootstrap stage.
type AssertEmpty<T extends never> = T;
type PublicExports = AssertEmpty<keyof typeof sdk>;
type ServerExports = AssertEmpty<keyof typeof server>;

// Deep implementation imports must stay outside the export map.
// @ts-expect-error This implementation path is not exported.
import 'handrail-agent-sdk/dist/server/index.js';
