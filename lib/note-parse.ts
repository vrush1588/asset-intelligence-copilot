// Turns a dataset `correction` note into field-level corrections.
// The dataset guide says a correction overrides the detection of its inspection. Today all
// sample corrections say "not a spill", but test data may correct a volume or a temperature,
// so those forms are recognised too.

export type FieldCorrection = { field: string; value: number; original: number | null; fallback?: boolean };

export function parseCorrectionNote(text: string, insp: any): FieldCorrection[] {
  const t = text.toLowerCase();
  const out: FieldCorrection[] = [];

  const vol = t.match(/(?:was|is|measured|actual(?:ly)?|real(?:ly)?|correct(?:ed)?(?: volume)?(?: is| to)?)\s*(?:about\s*)?(\d+(?:\.\d+)?)\s*(?:bbl|barrels?)/);
  if (vol && insp.spill_detected) out.push({ field: "spill_est_volume_bbl", value: Number(vol[1]), original: insp.spill_est_volume_bbl });

  const temp = t.match(/(?:wellhead|reading|re-?measured|actual|real|correct(?:ed)?)[^.]*?(\d+(?:\.\d+)?)\s*°?\s*c\b/);
  if (temp && /wellhead|thermal|reading|temperature/.test(t))
    out.push({ field: "wellhead_temp_c", value: Number(temp[1]), original: insp.wellhead_temp_c });

  const notSpill = /not (?:a )?(?:crude )?spill|no crude|not crude|false (?:positive|alarm)|not oil|rainwater|shadow|puddle/.test(t);
  if (notSpill && !out.some((c) => c.field === "spill_est_volume_bbl")) out.push({ field: "spill_detected", value: 0, original: insp.spill_detected ? 1 : 0 });

  // A correction note with no recognisable value still overrides the detection.
  if (!out.length && insp.spill_detected) out.push({ field: "spill_detected", value: 0, original: 1, fallback: true });
  return out;
}
