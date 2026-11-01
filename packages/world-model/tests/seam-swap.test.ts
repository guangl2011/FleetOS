import { ManualClock } from "@fleetos/adapters-sdk";
import { expect, expectTypeOf, it, describe } from "vitest";

import { DETERMINISTIC_PREDICTOR_ID, createWorldModel } from "../src/index.js";
import type {
  FleetPredictor,
  FleetWorldModel,
  PredictedFutures,
  PredictionContext,
} from "../src/index.js";
import { at, mowerRobot, sampleAt } from "./helpers.js";

/**
 * The prediction seam (spec D1): consumers call model.predict and see
 * PredictedFutures regardless of which predictor sits behind it. The MVP
 * ships the deterministic predictor; Phase I swaps a learned one through the
 * same FleetPredictor interface — these tests pin both the runtime swap and
 * the type-level contract (checked by `pnpm typecheck`).
 */
describe("prediction seam", () => {
  it("delegates to the configured predictor without changing the consumer shape", () => {
    const clock = new ManualClock(at(0));
    const sentinel: PredictedFutures = {
      predictorId: "learned-v0-stub",
      generatedAt: at(0),
      horizonMinutes: 30,
      robots: [],
    };
    const learned: FleetPredictor = {
      id: "learned-v0-stub",
      predict: (context: PredictionContext) => {
        // Prove the seam hands the predictor the full estimate + registry.
        expect(context.fleet.robots.length).toBe(1);
        expect(context.robots.get("robot-mower-01")?.vendor).toBe("greenworks");
        return sentinel;
      },
    };

    const model = createWorldModel({ robots: [mowerRobot()], clock, predictor: learned });
    expect(model.predictorId).toBe("learned-v0-stub");
    expect(model.predict(30)).toBe(sentinel); // the consumer sees the same typed output
  });

  it("defaults to the deterministic predictor", () => {
    const clock = new ManualClock(at(0));
    const model = createWorldModel({ robots: [mowerRobot()], clock });
    expect(model.predictorId).toBe(DETERMINISTIC_PREDICTOR_ID);
    model.ingest(sampleAt(at(0), "robot-mower-01", { batteryPct: 80 }));
    expect(model.predict(30).robots.length).toBe(1);
  });

  describe("type-level swap contract", () => {
    it("accepts a Phase I learned predictor without changing consumer types", () => {
      // A Phase I learned predictor may carry its own extra surface; the seam
      // stays structural — anything satisfying FleetPredictor fits.
      interface LearnedFleetPredictor extends FleetPredictor {
        readonly version: 2;
        readonly trainedOn: string;
      }
      const learned: LearnedFleetPredictor = {
        id: "learned-v2-stub",
        version: 2,
        trainedOn: "seeded-benchmark-corpus",
        predict: (context) => ({
          predictorId: "learned-v2-stub",
          generatedAt: context.now,
          horizonMinutes: context.horizonMinutes,
          robots: [],
        }),
      };

      const model = createWorldModel({
        robots: [mowerRobot()],
        clock: new ManualClock(at(0)),
        predictor: learned,
      });
      expectTypeOf(model).toEqualTypeOf<FleetWorldModel>();
      // Call-shape check via plain assignment — version-proof, checked by tsc.
      const predict: (horizonMinutes: number) => PredictedFutures = model.predict;
      void predict;
      expectTypeOf(model.predict(30)).toEqualTypeOf<PredictedFutures>();
      expect(model.predictorId).toBe("learned-v2-stub"); // runtime shape still flows through
    });
  });
});
