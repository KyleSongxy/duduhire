import { handleAnalysisRequest } from './analysis.js';
import { handleOperationsRequest } from './operations.js';

const worker = {
  async fetch(request, env) {
    const analysisResponse = await handleAnalysisRequest(request, env);
    if (analysisResponse) return analysisResponse;
    const operationsResponse = await handleOperationsRequest(request, env);
    if (operationsResponse) return operationsResponse;
    return env.ASSETS.fetch(request);
  },
};

export default worker;
