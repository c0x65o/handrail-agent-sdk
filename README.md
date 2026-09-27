# handrail-agent-sdk

Packaging bootstrap only; runtime features are not implemented yet.

Requires Node.js >=22.0.0 (a supported release satisfying the Node >=20
contract). Development uses npm 10.9.8 and pinned TypeScript 5.9.3.

```sh
npm ci --include=dev
npm run build
npm test
```

`--include=dev` installs the compiler even when the host sets `NODE_ENV=production`.
`prepare` compiles TypeScript during normal installation. `npm test` runs focused
packaging checks with TAP output against the built files.

The ESM entrypoints `handrail-agent-sdk` and `handrail-agent-sdk/server` have
separate declaration exports. Both are currently inert, with no feature exports;
the public root does not load server code.

Distribution policy: consumers must install from the public HTTPS Git repository
`https://github.com/c0x65o/handrail-agent-sdk.git`, pinned to a full 40-character
commit SHA, and commit the matching package-manager lockfile. Compilation stays
in the ordinary install/build pipeline. Registry publishing is disabled.
These local packaging checks do not prove public-Git consumer installation;
that remains the later M6 acceptance task.
