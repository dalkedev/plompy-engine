import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

const options={strict:false,allErrors:false,validateFormats:false,addUsedSchema:false};
const versions={draft7:new Ajv(options),draft2019:new Ajv2019(options),draft2020:new Ajv2020(options)};
export function compileSchema(schema) {
  const uri=schema.$schema??'';
  const validator=uri.includes('2020-12')?versions.draft2020:uri.includes('2019-09')?versions.draft2019:versions.draft7;
  return validator.compile(schema);
}
