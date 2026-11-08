import { runDoctor } from '../pkg/src/doctor.mjs'

const doctor = await runDoctor(null, { version: 'probe', capabilities: {}, flags: {} })
console.log(JSON.stringify(doctor, null, 2))
