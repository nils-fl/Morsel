import { describe, expect, it } from "vitest";
import { instrumentZones, kitPads, presetName, presetXml, readPreset } from "./presets";

// Hand-written in the shape of Live's preset XML (no Ableton content).
const branch = (stored: number, name: string, sample: string) => `
  <DrumBranchPreset Id="${stored}">
    <Name Value="" />
    <DevicePresets>
      <AbletonDevicePreset>
        <Device><OriginalSimpler Id="0"><UserName Value="" />
          <MultiSamplePart HasImportedSlicePoints="false" Id="0">
            <KeyRange><Min Value="0" /><Max Value="127" /></KeyRange>
            <SampleRef><FileRef><RelativePath Value="${sample}" /></FileRef></SampleRef>
          </MultiSamplePart>
        </OriginalSimpler></Device>
      </AbletonDevicePreset>
    </DevicePresets>
    <BranchInfo><UserName Value="${name}" /></BranchInfo>
    <ZoneSettings><ReceivingNote Value="${stored}" /></ZoneSettings>
  </DrumBranchPreset>`;

const kit = `<?xml version="1.0"?><Ableton><GroupDevicePreset><Device><DrumGroupDevice Id="0"></DrumGroupDevice></Device>
  <BranchPresets>
    ${branch(90, "Snare &amp; Rim", "Samples/One Shots/Drums/Snare/Snare A.aif")}
    ${branch(92, "", "Samples/One Shots/Drums/Kick/Kick A.aif")}
    <DrumBranchPreset Id="3"><ZoneSettings><ReceivingNote Value="91" /></ZoneSettings></DrumBranchPreset>
  </BranchPresets></GroupDevicePreset></Ableton>`;

const part = (lo: number, hi: number, vlo: number, vhi: number, root: number, sample: string) => `
  <MultiSamplePart HasImportedSlicePoints="false" Id="${lo}${vlo}">
    <KeyRange><Min Value="${lo}" /><Max Value="${hi}" /><CrossfadeMin Value="${lo}" /><CrossfadeMax Value="${hi}" /></KeyRange>
    <VelocityRange><Min Value="${vlo}" /><Max Value="${vhi}" /><CrossfadeMin Value="${vlo}" /><CrossfadeMax Value="${vhi}" /></VelocityRange>
    <RootKey Value="${root}" />
    <SampleRef><FileRef><RelativePath Value="${sample}" /></FileRef></SampleRef>
  </MultiSamplePart>`;

const piano = `<Ableton><GroupDevicePreset><Device><InstrumentGroupDevice Id="0" /></Device>
  <OriginalSimpler>
    ${part(48, 59, 1, 64, 54, "Samples/Multisamples/Piano/Piano F#2 p.aif")}
    ${part(48, 59, 65, 127, 54, "Samples/Multisamples/Piano/Piano F#2 f.aif")}
    ${part(36, 47, 65, 127, 42, "Samples/Multisamples/Piano/Piano F#1 f.aif")}
  </OriginalSimpler>
  <OriginalSimpler>
    ${part(48, 59, 65, 127, 54, "Samples/Multisamples/Piano/Piano F#2 release.aif")}
  </OriginalSimpler></GroupDevicePreset></Ableton>`;

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

describe("Live presets", () => {
  it("reads a Drum Rack's pads: note = 128 - stored, the branch's name, the sample's library path", () => {
    expect(kitPads(kit)).toEqual([
      { note: 36, name: "Kick A", sample: "Samples/One Shots/Drums/Kick/Kick A.aif" }, // no name: the sample's
      { note: 38, name: "Snare & Rim", sample: "Samples/One Shots/Drums/Snare/Snare A.aif" },
    ]); // the empty branch (no sample) is left out
  });

  it("reads an instrument's zones: the velocity 100 layer, one per key range, sorted", () => {
    expect(instrumentZones(piano)).toEqual([
      { sample: "Samples/Multisamples/Piano/Piano F#1 f.aif", root: 42, lo: 36, hi: 47 },
      { sample: "Samples/Multisamples/Piano/Piano F#2 f.aif", root: 54, lo: 48, hi: 59 },
    ]);
  });

  it("tells a kit from an instrument, and a synth (no samples) from both", async () => {
    expect(readPreset(await presetXml(await gzip(kit)), "My Kit")?.kind).toBe("kit");
    expect(readPreset(piano, "Piano")).toMatchObject({ kind: "instrument", name: "Piano" });
    expect(readPreset(`<Ableton><Drift Id="0"><Name Value="Bass" /></Drift></Ableton>`, "Bass")).toBeNull();
    expect(presetName("505 Core Kit.adg")).toBe("505 Core Kit");
  });
});
