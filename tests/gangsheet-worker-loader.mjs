// Node's test runner has no Vite `?worker` loader.  Keep the actual worker
// algorithms in the loop while adapting the browser Worker surface that the
// gang-sheet spot-color path expects.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/offload-health.ts")) {
    const loaded = await nextLoad(url, context);
    const source = String(loaded.source).replaceAll("import.meta.env", "({})");
    return { ...loaded, source, shortCircuit: true };
  }
  if (!url.includes("?worker")) return nextLoad(url, context);

  const source = `
    import { processOneSeparation } from "./spot-color-trace-core.ts";

    export default class GangSheetTestWorker {
      #listeners = new Map();

      addEventListener(type, listener) {
        this.#listeners.set(type, listener);
      }

      removeEventListener(type, listener) {
        if (this.#listeners.get(type) === listener) this.#listeners.delete(type);
      }

      terminate() {}

      #emit(type, event) {
        this.#listeners.get(type)?.(event);
      }

      postMessage(message) {
        queueMicrotask(() => {
          try {
            if (globalThis.__gangSheetWorkerFailure) {
              throw new Error("intentional gang-sheet worker failure");
            }

            const pixelData = new Uint8ClampedArray(message.imageBuffer);
            const fullAlphaMask = message.fullAlphaMask
              ? new Uint8Array(message.fullAlphaMask)
              : undefined;
            const region = processOneSeparation(
              pixelData,
              message.imageWidth,
              message.imageHeight,
              message.spotColors,
              message.markedColors,
              message.regionName,
              message.dpi,
              message.exactSelection,
              fullAlphaMask,
              message.allTaggedWhite,
              message.allTaggedGloss,
            );
            this.#emit("message", {
              data: { type: "result", regions: region ? [region] : [] },
            });
          } catch (error) {
            this.#emit("error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    }
  `;

  return { format: "module", source, shortCircuit: true };
}