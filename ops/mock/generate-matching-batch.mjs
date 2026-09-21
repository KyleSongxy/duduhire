import { writeFileSync } from 'node:fs';
import { emptyMatchingConstraints, validateMatchingDraft, rankMatches } from '../../apps/api/dist/matching.js';

export const version = 'mock-20260913-20-demands-100-capabilities-v1';
// Synthetic scenarios only. No users, verified identities, contact data or consent records.
const scenes = [
  ['ai','制造企业设备手册问答','设备手册分散，售后查找故障步骤耗时','知识库,RAG检索,智能问答,模型评估','手册分段、出处引用和无答案拒答','检索问题集与引用准确性检查',60000,''],
  ['ai','财务报销审核助手','报销附件格式不一，财务需要减少重复核对','财务流程,流程自动化,系统集成,测试验收','票据结构化、规则核对和人工复核队列','异常票据集与审计记录',45000,''],
  ['ai','售前方案检索与草稿','售前需要从历史方案中找到可复用内容','知识库,RAG检索,内容创作,提示词设计','方案检索、模板草稿和来源链接','方案覆盖率与引用核对报告',40000,''],
  ['ai','客服智能体转人工流程','客服机器人遇到复杂问题需要可靠转人工','AI智能体,客户服务,系统集成,模型评估','意图分类、工单转接和人工确认','转接成功率与越权问题测试集',55000,''],
  ['ai','销售CRM自动化','销售线索重复录入，跟进状态不同步','流程自动化,系统集成,后端开发,测试验收','表单去重、CRM同步和失败重试','接口回放用例与重试记录',35000,''],
  ['ai','电商商品内容工作台','商品上新需要统一文案并减少重复编辑','内容创作,提示词设计,前端开发,产品设计','产品信息整理、草稿生成和编辑审批','文案质量清单与可用性记录',38000,''],
  ['ai','制造质检数据看板','质检记录缺少统一分类，无法追溯异常趋势','数据治理,数据分析,数据可视化,系统集成','缺陷分类、指标口径和异常看板','数据对账结果与指标字典',50000,''],
  ['ai','内部模型推理监控','模型服务偶发超时，成本和错误缺少监控','模型部署,后端开发,模型评估,数据可视化','延迟监控、成本统计和回滚操作','负载测试结果与故障演练记录',65000,''],
  ['ai','招聘能力证据整理','招聘团队需要从候选材料整理可追溯能力证据','人力资源,需求分析,提示词设计,产品设计','材料结构化、证据定位和人工确认','证据遗漏与错误归因检查',42000,''],
  ['ai','合同条款检索试点','采购查找标准条款耗时，需要能定位出处的工具','知识库,RAG检索,前端开发,测试验收','条款检索、版本对照和权限界面','访问权限与版本一致性测试',58000,''],
  ['global','新加坡B2B软件市场验证','软件团队需要验证当地客户痛点与采购路径','海外市场调研,出海策略,数据分析,项目管理','客户分层、竞争研究和访谈提纲','研究来源表与访谈问题清单',40000,'新加坡'],
  ['global','美国家居品牌获客试点','独立站访问量低，需要验证可复查的获客渠道','海外获客,广告投放,数据分析,市场营销','广告结构、转化追踪和落地页实验','渠道归因看板与实验复盘',36000,'美国'],
  ['global','日本SaaS产品本地化','软件帮助中心需要日语术语与关键页面适配','内容本地化,内容创作,客户服务,产品设计','术语表、帮助页面和审校流程','双语对照稿与本地化检查表',32000,'日本'],
  ['global','德国工业设备渠道筛选','设备企业缺少进入当地市场的渠道研究','渠道拓展,海外市场调研,项目管理,跨境运营','伙伴研究、筛选标准和沟通计划','研究依据与候选渠道评分表',48000,'德国'],
  ['global','英国专业服务SEO','咨询网站需要面向当地企业采购者优化内容','SEO优化,内容创作,海外获客,数据分析','关键词分组、内容日历和页面优化','搜索意图分析与站点审计',28000,'英国'],
  ['global','东南亚电商运营整理','品牌需梳理泰国站点上新和库存协作流程','跨境电商,跨境运营,数据分析,流程自动化','SKU整理、运营看板和异常跟进','库存对账与运营操作手册',30000,'泰国'],
  ['global','法国消费品牌内容适配','品牌准备上线法语产品页和常见问题说明','内容本地化,内容创作,市场营销,客户服务','产品文稿、术语整理和编辑校对','法语审校清单与前后对照稿',34000,'法国'],
  ['global','澳大利亚B2B线索研究','企业需要建立有来源和筛选理由的客户研究库','海外市场调研,海外获客,数据分析,项目管理','客户画像、渠道研究和研究库结构','来源清单与筛选标准复核',38000,'澳大利亚'],
  ['global','阿联酋产品市场进入研究','团队需要了解目标行业采购习惯与进入路径','出海策略,海外市场调研,渠道拓展,项目管理','行业研究、进入路径和试点计划','研究来源与风险假设表',52000,'阿联酋'],
  ['global','韩国跨境客服流程','电商品牌需要建立韩语问答与工单升级规则','客户服务,内容本地化,跨境运营,流程自动化','常见问题、工单分类和升级流程','问答术语表与工单回放测试',26000,'韩国'],
];
const variants = [
  ['方案设计','需求分析','需求访谈、边界定义和验收指标','范围说明、原型与验收矩阵',0.60,24],
  ['工程实施','系统集成','可运行原型、数据处理和接口实现','操作示例、实现说明与交接清单',0.75,32],
  ['质量评估','测试验收','样本设计、错误分类和复现检查','测试样本、问题记录与改进建议',0.42,16],
  ['交付协调','项目管理','阶段计划、依赖跟踪和跨团队沟通','里程碑、责任清单与风险记录',0.55,20],
  ['持续运营','数据分析','指标口径、日常跟踪和迭代复盘','指标字典、周报模板与维护说明',0.45,12],
];
const languages = { 日本:['日语','中文'], 法国:['法语','英语'], 韩国:['韩语','中文'], 德国:['德语','英语'], 泰国:['泰语','英语'] };
export const records = [];
for (const [index, scene] of scenes.entries()) {
  const [domain,title,problem,skillText,delivery,evidence,budget,market] = scene;
  const skills=skillText.split(',');
  const serial=String(index+1).padStart(2,'0');
  const engagement=index%4===0?'part_time':'project';
  const workMode=index%5===0?'hybrid':'remote';
  const location=workMode==='hybrid'?['上海','杭州','北京','深圳'][Math.floor(index/5)]:'';
  const conditions={...emptyMatchingConstraints(),markets:market?[market]:[],languages:market?(languages[market]??['英语']):['中文'],budgetCurrency:'CNY',budgetPeriod:engagement==='part_time'?'month':'project',weeklyHours:12,availableFrom:'2026-10-01'};
  const draft=validateMatchingDraft('problem',{
    title:`示例需求 ${serial}｜${title}`,summary:`虚构测试场景：${problem}。首期范围为${delivery}，以${evidence}作为交付验收依据。先做小范围验证；上线范围及后续投入由需求方另行确认。`,skills,requiredSkills:skills.slice(0,2),workMode,engagement,location,
    notes:'Mock 数据，仅用于匹配测试，不代表真实招聘、采购或合作机会。服务费为虚构预算，不含媒体或第三方费用。',constraints:{...conditions,budgetMax:budget},
  });
  records.push({id:`example-20260913-demand-${serial}`,kind:'problem',domain,draft});
  for(const [j,[focus,extra,activity,output,ratio,hours]] of variants.entries()) {
    const chosen=j===2?skills.slice(1):skills.slice(0,3);
    const talentSkills=[...new Set([...chosen,extra])];
    records.push({id:`example-20260913-capability-${serial}-${j+1}`,kind:'capability',domain,draft:validateMatchingDraft('capability',{
      title:`示例能力 ${serial}-${j+1}｜${title}·${focus}`,
      summary:`虚构能力档案：在${title}的模拟项目中负责${activity}，可交付${output}。能力证据示例包括${evidence}；个人职责限于${focus}，其他环节需与伙伴配合。经历与材料均为测试设定，未经真实验证。`,
      skills:talentSkills,requiredSkills:[],workMode:j===3?'any':workMode,engagement:j===4?'part_time':engagement,location:j===3?'':location,
      notes:'Mock 数据，非真实个人；无联系方式、认证或合作承诺。用于测试技能覆盖、预算、工时及协作方式差异。',
      constraints:{...conditions,budgetMin:Math.round(budget*ratio/1000)*1000,budgetMax:Math.round(budget*(ratio+0.15)/1000)*1000,weeklyHours:hours,budgetPeriod:j===4?'month':conditions.budgetPeriod,availableFrom:j===4?'2026-10-15':'2026-09-20'},
    })});
  }
}
if(records.filter(r=>r.kind==='problem').length!==20||records.filter(r=>r.kind==='capability').length!==100||new Set(records.map(r=>r.id)).size!==120)throw Error('count_mismatch');
const listing=r=>({...r.draft,id:r.id,kind:r.kind,version:1,createdAt:'2026-09-13T00:00:00Z',updatedAt:'2026-09-13T00:00:00Z',isExample:true,contactable:false});
const coverage=records.filter(r=>r.kind==='problem').map(r=>({id:r.id,matches:rankMatches(listing(r),records.filter(x=>x.kind==='capability').map(listing)).length}));
if(coverage.some(x=>x.matches===0))throw Error('unmatchable_demand');
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify({version,records},null,2)+'\n');
console.log(JSON.stringify({version,demands:20,capabilities:100,uniqueTitles:new Set(records.map(r=>r.draft.title)).size,minimumMatches:Math.min(...coverage.map(x=>x.matches))}));
