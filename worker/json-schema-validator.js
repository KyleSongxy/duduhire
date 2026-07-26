function resolveReference(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported schema reference: ${reference}`);
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((current, part) => current?.[part], rootSchema);
}

function isType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addError(errors, instancePath, message) {
  errors.push({ instancePath: instancePath || '/', message });
}

function validateNode(schema, value, rootSchema, instancePath, errors) {
  if (schema.$ref) {
    const resolved = resolveReference(rootSchema, schema.$ref);
    if (!resolved) {
      addError(errors, instancePath, `references unknown schema ${schema.$ref}`);
      return;
    }
    validateNode(resolved, value, rootSchema, instancePath, errors);
    return;
  }

  if ('const' in schema && !sameValue(value, schema.const)) {
    addError(errors, instancePath, 'must equal the required constant');
  }
  if (schema.enum && !schema.enum.some((item) => sameValue(value, item))) {
    addError(errors, instancePath, 'must equal one of the allowed values');
  }

  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => isType(value, type))) {
      addError(errors, instancePath, `must be ${allowedTypes.join(' or ')}`);
      return;
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      addError(errors, instancePath, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      addError(errors, instancePath, `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      addError(errors, instancePath, `must match ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addError(errors, instancePath, `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addError(errors, instancePath, `must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addError(errors, instancePath, `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      addError(errors, instancePath, `must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        addError(errors, instancePath, 'must not contain duplicate items');
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateNode(schema.items, item, rootSchema, `${instancePath}/${index}`, errors);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!(required in value)) {
        addError(errors, instancePath, `must contain required property ${required}`);
      }
    }
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) {
        validateNode(properties[key], item, rootSchema, `${instancePath}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        addError(errors, `${instancePath}/${key}`, 'is not an allowed property');
      }
    }
  }
}

export function validateJsonSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, schema, '', errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}
