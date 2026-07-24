function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function parseEsf551Measurement(value) {
  const view = value instanceof DataView
    ? value
    : new DataView(value?.buffer || value);
  if (
    view.byteLength !== 22
    || view.getUint8(0) !== 0xa5
    || view.getUint8(1) !== 0x02
    || view.getUint8(3) !== 0x10
    || view.getUint8(4) !== 0x00
    || view.getUint8(6) !== 0x01
    || view.getUint8(7) !== 0x61
    || view.getUint8(8) !== 0xa1
    || view.getUint8(9) !== 0x00
    || view.getUint8(19) !== 0x01
  ) {
    return null;
  }

  const weightRaw = (
    view.getUint8(10)
    | (view.getUint8(11) << 8)
    | (view.getUint8(12) << 16)
  );
  const impedance = view.getUint16(13, true);
  return {
    weight_kg: round(weightRaw / 1000, 2),
    impedance_ohms: view.getUint8(20) === 1 && impedance > 0 ? impedance : null,
    display_unit: view.getUint8(21),
  };
}

export function calculateEsf551BodyComposition({
  weightKg,
  impedanceOhms,
  heightCm,
  age,
  biologicalSex,
}) {
  const weight = finite(weightKg);
  const impedance = finite(impedanceOhms);
  const height = finite(heightCm) / 100;
  const ageYears = finite(age);
  const sex = String(biologicalSex || "").toLowerCase() === "female" ? 1 : 0;

  if (!(weight > 0) || !(impedance > 0) || !(height > 0) || !(ageYears > 0)) {
    throw new Error("Weight, impedance, height, and age are required for body-composition estimates.");
  }

  const bmi = Math.floor((weight / (height ** 2)) * 100) / 100;
  const ageFactor = [0.103, 0.097];
  const bmiFactor = [1.524, 1.545];
  const bodyFatConstant = [22, 12.7];
  const rawBodyFat = Math.floor((
    ageFactor[sex] * ageYears
    + bmiFactor[sex] * bmi
    - 500 / impedance
    - bodyFatConstant[sex]
  ) * 10) / 10;
  const bodyFatPercent = clamp(rawBodyFat, 5, 75);
  const fatFreeWeight = round(weight * (1 - bodyFatPercent / 100), 2);

  const visceralBmiFactor = [0.8666, 0.8895];
  const visceralBfpFactor = [0.0082, 0.0943];
  const visceralFatFactor = [0.026, -0.0534];
  const visceralConstant = [14.2692, 16.215];
  const visceralFat = clamp(Math.trunc(
    visceralBmiFactor[sex] * bmi
    + visceralBfpFactor[sex] * bodyFatPercent
    + visceralFatFactor[sex] * (weight - fatFreeWeight)
    - visceralConstant[sex],
  ), 1, 30);

  const subcutaneousBfpFactor = [0.965, 0.983];
  const subcutaneousVisceralFactor = [0.22, 0.303];
  const subcutaneousFatPercent = round(
    subcutaneousBfpFactor[sex] * bodyFatPercent
    - subcutaneousVisceralFactor[sex] * visceralFat,
    1,
  );

  const structuralFraction = [0.05, 0.06];
  const waterFraction = [0.76, 0.73];
  const skeletalFraction = [0.68, 0.62];
  const structuralMass = Math.max(1, structuralFraction[sex] * fatFreeWeight);
  const bodyWaterPercent = clamp(round(
    waterFraction[sex] * (fatFreeWeight - structuralMass) / weight * 100,
    1,
  ), 10, 80);
  const skeletalMusclePercent = round(
    skeletalFraction[sex] * (fatFreeWeight - structuralMass) / weight * 100,
    1,
  );
  const muscleMass = round(fatFreeWeight - structuralMass, 2);
  const boneMass = Math.max(1, round(structuralFraction[sex] * fatFreeWeight, 2));
  const proteinFactor = [1, 1.05];
  const proteinPercent = Math.max(5, round(
    100
    - proteinFactor[sex] * bodyFatPercent
    - boneMass / weight * 100
    - bodyWaterPercent,
    1,
  ));
  const basalMetabolicRate = clamp(Math.trunc(fatFreeWeight * 21.6 + 370), 900, 2500);

  const idealHeightFactor = [100, 137];
  const idealConstant = [80, 110];
  const idealFactor = [0.7, 0.45];
  const idealWeight = idealFactor[sex] * (idealHeightFactor[sex] * height - idealConstant[sex]);
  let weightScore = 0;
  if (idealWeight <= weight) {
    weightScore = idealWeight * 1.3 < weight
      ? 50
      : Math.trunc(100 - 50 * (weight - idealWeight) / (0.3 * idealWeight));
  } else if (idealWeight * 0.7 < weight) {
    weightScore = Math.trunc(100 - 50 * (idealWeight - weight) / (0.3 * idealWeight));
  } else {
    for (let x = 0; x < 6; x += 1) {
      if (idealWeight * x / 10 > weight) {
        weightScore = x * 10;
        break;
      }
    }
  }

  const idealFat = [16, 26][sex];
  const fatScore = idealFat < bodyFatPercent
    ? (bodyFatPercent >= 45
      ? 50
      : Math.trunc(100 - 50 * (bodyFatPercent - idealFat) / (45 - idealFat)))
    : Math.trunc(100 - 50 * (idealFat - bodyFatPercent) / (idealFat - 5));
  let bmiScore;
  if (bmi >= 22) bmiScore = bmi >= 35 ? 50 : Math.trunc(100 - 3.85 * (bmi - 22));
  else if (bmi >= 15) bmiScore = Math.trunc(100 - 3.85 * (22 - bmi));
  else if (bmi >= 10) bmiScore = 40;
  else if (bmi >= 5) bmiScore = 30;
  else bmiScore = 20;
  const healthScore = Math.floor((weightScore + fatScore + bmiScore) / 3);
  const metabolicAgeAdjustment = healthScore < 50 ? 0
    : healthScore < 60 ? 1
      : healthScore < 65 ? 2
        : healthScore < 68 ? 3
          : healthScore < 70 ? 4
            : healthScore < 73 ? 5
              : healthScore < 75 ? 6
                : healthScore < 80 ? 7
                  : healthScore < 85 ? 8
                    : healthScore < 88 ? 9
                      : healthScore < 90 ? 10
                        : healthScore < 93 ? 11
                          : healthScore < 95 ? 12
                            : healthScore < 97 ? 13
                              : healthScore < 98 ? 14
                                : healthScore < 99 ? 15 : 16;

  return {
    weight_kg: weight,
    impedance_ohms: impedance,
    bmi,
    body_fat_percent: bodyFatPercent,
    lean_body_mass_kg: fatFreeWeight,
    fat_free_body_weight_kg: fatFreeWeight,
    subcutaneous_fat_percent: subcutaneousFatPercent,
    visceral_fat: visceralFat,
    body_water_percent: bodyWaterPercent,
    body_water_mass_kg: round(weight * bodyWaterPercent / 100, 2),
    basal_metabolic_rate_kcal_day: basalMetabolicRate,
    skeletal_muscle_percent: skeletalMusclePercent,
    muscle_mass_kg: muscleMass,
    bone_mass_kg: boneMass,
    protein_percent: proteinPercent,
    metabolic_age: Math.max(18, Math.trunc(ageYears + 8 - metabolicAgeAdjustment)),
    composition_method: "ESF-551 weight + bioimpedance estimate",
  };
}
