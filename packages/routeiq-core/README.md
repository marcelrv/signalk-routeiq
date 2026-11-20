# routeiq-core

The routing engine of `signalk-routeiq`, packaged so it can be reused and tested
outside Signal K.

This package is internal. It is private, not published, and for now it is bundled
into the plugin at build time (the plugin lists it as a workspace devDependency).
It currently exports only `CORE_VERSION`; the engine moves here step by step.

## Build and test

From the repository root:

```
npm run build      # builds this package first, then the plugin
npm test           # plugin tests, then this package's tests
```

Or only this package: `npm run build -w routeiq-core` and `npm test -w routeiq-core`.
