import { ok, match, doesNotMatch } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("csharp emitter - @encode", () => {
  describe("date/time as unix timestamp", () => {
    it("maps utcDateTime encoded as int32 to a C# integer", async () => {
      const results = await emit(`
        namespace Demo;
        model Event {
          @encode("unixTimestamp", int32)
          createdAt: utcDateTime;
        }
      `);
      const file = results["Event.g.cs"];
      ok(file, "expected Event.g.cs");
      match(file, /public int\? CreatedAt \{ get; set; \}/);
    });

    it("honors the int64 encode target width", async () => {
      const results = await emit(`
        namespace Demo;
        model Event {
          @encode("unixTimestamp", int64)
          createdAt: utcDateTime;
        }
      `);
      match(results["Event.g.cs"], /public long\? CreatedAt \{ get; set; \}/);
    });
  });

  describe("duration as seconds", () => {
    it("maps a duration encoded as int32 to a C# integer", async () => {
      const results = await emit(`
        namespace Demo;
        model Session {
          @encode("seconds", int32)
          ttl: duration;
        }
      `);
      match(results["Session.g.cs"], /public int\? Ttl \{ get; set; \}/);
    });

    it("maps a duration encoded as float64 to a C# double", async () => {
      const results = await emit(`
        namespace Demo;
        model Session {
          @encode("seconds", float64)
          ttl: duration;
        }
      `);
      match(results["Session.g.cs"], /public double\? Ttl \{ get; set; \}/);
    });
  });

  describe("numeric as string", () => {
    it("keeps the numeric type and adds JsonNumberHandling", async () => {
      const results = await emit(`
        namespace Demo;
        model Account {
          @encode(string)
          balance: int64;
        }
      `);
      const file = results["Account.g.cs"];
      ok(file, "expected Account.g.cs");
      match(
        file,
        /\[JsonNumberHandling\(JsonNumberHandling\.AllowReadingFromString \| JsonNumberHandling\.WriteAsString\)\]/,
      );
      match(file, /public long\? Balance \{ get; set; \}/);
    });
  });

  describe("boolean as string (TypeSpec 1.14.0)", () => {
    it("adds a JsonConverter and emits the converter helper", async () => {
      const results = await emit(`
        namespace Demo;
        model Flag {
          @encode(string)
          active: boolean;
        }
      `);
      const file = results["Flag.g.cs"];
      ok(file, "expected Flag.g.cs");
      match(
        file,
        /\[JsonConverter\(typeof\(Demo\.Helpers\.BooleanStringJsonConverter\)\)\]/,
      );
      match(file, /public bool\? Active \{ get; set; \}/);

      const helper = results["Helpers/BooleanStringJsonConverter.g.cs"];
      ok(helper, "expected the BooleanStringJsonConverter helper file");
      match(helper, /class BooleanStringJsonConverter : JsonConverter<bool>/);
    });

    it("does not emit the converter helper when unused", async () => {
      const results = await emit(`
        namespace Demo;
        model Flag { active: boolean; }
      `);
      ok(
        !results["Helpers/BooleanStringJsonConverter.g.cs"],
        "converter helper should not be emitted without @encode(string) on a boolean",
      );
      doesNotMatch(results["Flag.g.cs"], /BooleanStringJsonConverter/);
    });
  });
});
