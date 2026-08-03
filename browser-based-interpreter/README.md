# AFM Browser-based Interpreter

A web app that runs an [AFM](https://wso2.github.io/agent-flavored-markdown/) agent in the browser. So far it has the project set-up and the code that reads, checks and edits agent files. There is no UI yet, so the page only shows a heading.

## Run it

You need Node.js 24 and pnpm 11 (`packageManager` pins the version). The five `@afm/*` packages are installed from the `typescript-interpreter/` folder next to this one (`file:../typescript-interpreter/packages/*`), so work from a checkout of the whole repository. If that folder is not there yet, it comes from #42, the TypeScript interpreter.

```sh
cd browser-based-interpreter
pnpm install
pnpm dev        # http://localhost:5173
pnpm check      # typecheck and tests
pnpm build      # production files in dist/
```
