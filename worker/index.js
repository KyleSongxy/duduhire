import { handleAnalysisRequest } from './analysis.js';

const worker = {
  async fetch(request, env) {
    const analysisResponse = await handleAnalysisRequest(request, env);
    if (analysisResponse) return analysisResponse;
    return env.ASSETS.fetch(request);
  },
};

export default worker;
