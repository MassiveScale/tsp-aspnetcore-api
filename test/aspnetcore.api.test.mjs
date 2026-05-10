// VS Code's Node test discovery works best with JS/MJS entrypoints.
// This shim loads the compiled test suite from dist.
import "../dist/test/aspnetcore.api.test.js";
