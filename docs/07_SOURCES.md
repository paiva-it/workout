# Sources and verification notes

Prepared October 25, 2026. The specific routines, ordering, conservative restart phases and application architecture are original design choices for this handoff; they are not a published clinical prescription or a copied coach's program.

## Exercise guidance

- ACSM, March 17, 2026: [Updated resistance training guidance](https://acsm.org/resistance-training-guidelines-update-2026/). Supports consistent training, major-muscle coverage at least twice weekly and the fact that failure/complex methods are not required for typical healthy adults. The early phase here uses less volume for a gradual return; approximate hypertrophy targets are not mandatory starting quotas.
- CDC: [Adult activity overview](https://www.cdc.gov/physical-activity-basics/guidelines/adults.html). General adult guidance includes muscle strengthening on at least two days and 150 minutes of moderate aerobic activity weekly. Build toward activity targets gradually; they are not an instruction to jump into vigorous daily training.
- American Thoracic Society: [Asthma and exercise](https://site.thoracic.org/advocacy-patients/patient-resources/asthma-and-exercise-for-children-and-adults). Warm-up/cooldown and an existing asthma action plan matter; this pack does not change medication.
- Asthma + Lung UK: [Exercise and asthma](https://www.asthmaandlung.org.uk/conditions/asthma/asthma-triggers/when-exercise-triggers-your-asthma). Relevant to cold/dry air and symptom management in a garage.
- Cambridge University Hospitals: [Exercise stop symptoms](https://www.cuh.nhs.uk/patient-information/cardiac-rehabilitation-home-exercise-guidelines/). Cited only for general stop symptoms such as dizziness, chest pain and uncomfortable breathing, not as a diagnosis or a cardiac rehabilitation prescription.
- ACE: [Romanian deadlift technique](https://www.acefitness.org/continuing-education/certified/may-2025/8865/the-ace-do-it-better-series-the-romanian-deadlift/). Hip hinge, controlled position and range.

YouTube links, titles, creators, usage notes and check dates are stored in `data/training-pack.v1.json`. Metadata was located and matched through web search. Full playback/embedding was not tested in this handoff environment, so `playbackVerified` and `embeddingVerified` are false. Video availability may change. These are demonstrations only; follow this pack for volume and effort. No video content is downloaded or redistributed.

## Implementation references

- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): Argon2id and minimum work factors.
- [NestJS MongoDB integration](https://docs.nestjs.com/techniques/mongodb): official integration reference.
- [NestJS authentication](https://docs.nestjs.com/security/authentication): official framework guidance; the app's session-cookie design is specified separately.
- [MongoDB TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/): automatic cleanup is not an authorization expiry check.

Claude must check currently supported package/runtime versions when implementing. This handoff intentionally does not guess the deployed machine's proxy, IP address, paths, credentials or software versions.
