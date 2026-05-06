import { app } from "../../scripts/app.js";
import { tryToGetWorkflowDataFromEvent } from "../../rgthree/common/utils_workflow.js";
import { SERVICE as CONFIG_SERVICE } from "./services/config_service.js";
app.registerExtension({
    name: "rgthree.ImportIndividualNodes",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const onDragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (e) {
            var _a;
            let handled = (_a = onDragOver === null || onDragOver === void 0 ? void 0 : onDragOver.apply) === null || _a === void 0 ? void 0 : _a.call(onDragOver, this, [...arguments]);
            if (handled != null) {
                return handled;
            }
            return importIndividualNodesInnerOnDragOver(this, e);
        };
        const onDragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = async function (e) {
            var _a;
            const alreadyHandled = await ((_a = onDragDrop === null || onDragDrop === void 0 ? void 0 : onDragDrop.apply) === null || _a === void 0 ? void 0 : _a.call(onDragDrop, this, [...arguments]));
            if (alreadyHandled) {
                return alreadyHandled;
            }
            return importIndividualNodesInnerOnDragDrop(this, e);
        };
    },
});
export function importIndividualNodesInnerOnDragOver(node, e) {
    var _a;
    return ((((_a = node.widgets) === null || _a === void 0 ? void 0 : _a.length) && !!CONFIG_SERVICE.getFeatureValue("import_individual_nodes.enabled")) ||
        false);
}

function toNodeLabel(node) {
    return `${node.title || node.type || "Node"}${node.id != null ? ` #${node.id}` : ""}`;
}

function buildGraphCtx(workflow, prompt) {
    const promptData = new Map(
        Object.entries(prompt ?? {}).map(([k, v]) => [
            isNaN(k) ? k : Number(k),
            v
        ])
    );
    const nodes = workflow?.nodes ?? [];
    const nodesById = new Map(workflow.nodes.map(n => [n.id, n]));
    const normalizedLinks = workflow.links.map(l => Array.isArray(l) ?
        { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } :
        { ...l });
    const linksById = new Map(normalizedLinks.map(l => [l.id, l]));
    const subs = workflow.definitions?.subgraphs || [];
    const subsById = new Map(subs?.map(s => [s.id, s]));
    const subsNodes = subs?.flatMap(n => n.nodes);
    const subsLinks = subs?.flatMap(l => l.links);
    const subsNodesById = new Map(subsNodes.map(n => [n.id, n]));
    const subsLinksById = new Map(subsLinks.map(l => [l.id, l]));
    const subsProxyNodes = workflow.nodes.filter(n => subsById.has(n.type));
    const subsProxyNodesById = new Map(subsProxyNodes.map(n => [n.id, n]));
    const subsProxyNodesByType = new Map(subsProxyNodes.map(n => [n.type, n]));
    const subgraphByNodeId = new Map();
    for (const node of nodes) {
        const sub = subs?.find(sg => sg.id === node.type);
        if (sub) {
            subgraphByNodeId.set(node.id, { node, sub });
        }
    }
    const allNodes = [];
    const idMap = new Map();
    for (const node of nodes) {
        if (subgraphByNodeId.has(node.id)) continue;
        allNodes.push({ ...node });
    }
    for (const [, key] of subgraphByNodeId.entries()) {
        const prefix = `${key.node.id}:`;
        if (key.sub.nodes) {
            for (const innerNode of key.sub.nodes) {
                const newId = prefix + innerNode.id;
                allNodes.push({ ...innerNode, id: newId });
                idMap.set(String(innerNode.id), newId);
            }
        }
    }
    const allNodesById = new Map(allNodes.map(n => [n.id, n]));
    const allActiveNodes = allNodes.filter(n => n.mode === 0);
    return {
        promptData,
        nodes,
        nodesById,
        linksById,
        subsById,
        subsProxyNodes,
        subsProxyNodesById,
        subsProxyNodesByType,
        subsNodes,
        subsNodesById,
        subsLinksById,
        allNodesById,
        allActiveNodes
    }
}

function enterSub(link, graphCtx) {
    const subNode = graphCtx.subsProxyNodesById.get(link.target_id);
    const sub = graphCtx.subsById.get(subNode.type);
    const subNodeInputName = subNode.inputs[link.target_slot].name;
    const entryLinks = sub.inputs.find(i => i.name === subNodeInputName).linkIds;
    return entryLinks || [];
}

function exitSub(link, graphCtx) {
    const sub = [...graphCtx.subsById.values()].find(s => s.links.includes(link));
    const subNode = graphCtx.subsProxyNodesByType.get(sub.id);
    const subOutputsMap = new Map(sub.outputs.map(o => [o.linkIds[0], o]));
    const subOutputName = subOutputsMap.get(link.id).name;
    const subNodeOutputsByName = new Map(subNode.outputs.map(o => [o.name, o]));
    const exitLinks = subNodeOutputsByName.get(subOutputName).links;
    return exitLinks || [];
}

function getDownstreamSignals(startNode, graphCtx) {
    const queue = [startNode];
    const visited = new Set([startNode.id]);
    const allowedLinkTypes = [
        "CONDITIONING",
        "STRING",
        "MODEL",
        "LATENT",
        "INT",
        "FLOAT",
        "SIGMAS",
        "SAMPLER",
        "NOISE",
    ];
    const initialLinkTypes = startNode.outputs.flatMap(o => o.links && allowedLinkTypes.some(t => t === o.type) ? o.type : []);
    const allowedPaths = initialLinkTypes.includes("STRING")
        ? [...initialLinkTypes, "CONDITIONING"]
        : initialLinkTypes;
    const signals = {
        reachesSampler: false,
        reachesModel: false,
        reachesPositive: false,
        reachesNegative: false,
        reachesInt: false,
        reachesFloat: false,
        reachesLatent: false,
    };
    if (!allowedPaths.length) return signals;
    while (queue.length > 0) {
        const currentNode = queue.shift();
        for (const output of currentNode.outputs) {
            if (!output.links || !allowedPaths.includes(output.type)) continue;
            const linksQueue = [...output.links];
            for (const linkId of linksQueue) {
                const link = graphCtx.linksById.get(linkId) ?? graphCtx.subsLinksById.get(linkId);
                if (!link) continue;
                if (link.target_id === -20) {
                    linksQueue.push(...exitSub(link, graphCtx));
                    continue;
                }
                const targetNode = graphCtx.nodesById.get(link.target_id) ?? graphCtx.subsNodesById.get(link.target_id);
                if (!targetNode) continue;
                if (graphCtx.subsProxyNodesById.has(targetNode.id)) {
                    linksQueue.push(...enterSub(link, graphCtx));
                    continue;
                }
                const targetInput = targetNode.inputs[link.target_slot];
                if (!targetInput) continue;
                const inputName = (targetInput.name || "").toLowerCase();
                const targetType = (targetNode.type || "").toLowerCase();
                const currentLinkType = link.type;
                if (targetNode.mode !== 4 && targetType.includes("sampler")) {
                    signals.reachesSampler = true;
                    if (inputName.includes("model") && currentLinkType === "MODEL") {
                        signals.reachesModel = true;
                    }
                    if (inputName.includes("positive") && currentLinkType === "CONDITIONING") {
                        signals.reachesPositive = true;
                    }
                    if (inputName.includes("negative") && currentLinkType === "CONDITIONING") {
                        signals.reachesNegative = true;
                    }
                    if (/(seed|steps)/.test(inputName) && currentLinkType === "INT") {
                        signals.reachesInt = true;
                    }
                    if (inputName.includes("cfg") && currentLinkType === "FLOAT") {
                        signals.reachesFloat = true;
                    }
                    if (inputName.includes("latent") && currentLinkType === "LATENT") {
                        signals.reachesLatent = true;
                    }
                }
                if (!visited.has(targetNode.id)) {
                    visited.add(targetNode.id);
                    queue.push(targetNode);
                }
            }
        }
    }
    return signals;
}

function asumePrompt(widgetValue) {
    if (typeof widgetValue !== 'string') return { pos: 0, neg: 0 };
    const text = widgetValue.toLowerCase();
    let baseScore = 0;
    let posScore = 0;
    let negScore = 0;
    if (text.length > 15) baseScore += 1;
    if (text.length > 50) baseScore += 1;
    if (/\([\w\s,.-]+:\d*\.?\d+\)/.test(text)) baseScore += 2;
    if (/\[[\w\s,.-]+\]/.test(text)) baseScore += 1;
    if (/\([\w\s,.-]+\)/.test(text)) baseScore += 1;
    if (/\\\([\w\s]+\\\)/.test(text)) posScore += 2, negScore += 1;
    const commaCount = (text.match(/,/g) || []).length;
    if (commaCount >= 3) baseScore += 2;
    if (/<lora:[^:]+:\d*\.?\d+>/.test(text)) posScore += 1;
    const posMarkers = [
        'masterpiece', 'best quality', 'highres', 'painting', 'detailed',
        'realistic', '1girl', '1boy', '4k', '8k', 'raw photo', 'cinematic'
    ];
    for (const marker of posMarkers) {
        if (text.includes(marker)) posScore += 1;
    }
    const negMarkers = [
        'worst quality', 'lowres', 'bad quality', 'low quality', 'normal quality',
        'bad anatomy', 'bad hands', 'missing fingers', 'extra digit', 'fewer digits',
        'mutated', 'deformed', 'ugly', 'poorly drawn',
        'cropped', 'watermark', 'signature', 'text', 'username', 'jpeg artifacts', 'blurry'
    ];
    for (const marker of negMarkers) {
        if (text.includes(marker)) negScore += 1;
    }
    if (text.includes('easynegative') || text.includes('badhand')) negScore += 3;
    if (/embedding:.*(neg|bad).*/.test(text)) negScore += 2;
    if (text.includes('{') && text.includes('}')) baseScore -= 5;
    if (/^[a-zA-Z0-9_/\\]+\.(safetensors|ckpt|pt|pth|bin)$/i.test(text)) baseScore -= 5;

    return {
        pos: Math.max(0, baseScore + posScore),
        neg: Math.max(0, baseScore + negScore)
    };
}

function analyzeWidgets(node, graphCtx) {
    const hints = {
        hasModel: false,
        hasLora: false,
        hasPositive: false,
        hasNegative: false,
        hasPrompt: false,
        hasGenParams: false,
        hasDimensions: false,
    };
    const hasPromptData = graphCtx.promptData?.has(node.id);
    const hasWidgetNames = hasPromptData ? (...names) =>
        Object.keys(graphCtx.promptData.get(node.id).inputs)
            ?.some(o => names.some(name => o.toLocaleLowerCase().includes(name))) : true;
    if (!node.widgets_values || !Array.isArray(node.widgets_values)) {
        return hints;
    }
    for (const value of node.widgets_values) {
        const positive = asumePrompt(value).pos;
        const negative = asumePrompt(value).neg;
        if (typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|sft)$/i.test(value)) {
            hints.hasModel = true;
        }
        if (typeof value === 'string' && /(\.safetensors|lora)/i.test(value)) {
            hints.hasLora = true;
        }

        if (positive >= 3 && positive > negative) {
            hints.hasPositive = true;
        }
        if (negative >= 3 && positive < negative) {
            hints.hasNegative = true;
        }
        if (positive >= 3 || negative >= 3) {
            hints.hasPrompt = true;
        }

        if (typeof value === 'string') {
            const samplers = ['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim', 'lms'];
            const schedulers = ['normal', 'simple', 'karras', 'exponential', 'sgm_uniform', 'ddim'];
            if (/(euler|dpmpp|ddim_|lms|normal|simple|karras|exponential|sgm_|ddim_)/i.test(value) && !hints.hasPrompt) {
                hints.hasGenParams = true;
            }
        }

        if (typeof value === 'number' && Number.isInteger(value) && value >= 256 && value <= 4096 && value % 8 === 0) {
            // Чтобы не спутать с seed или шагами
            hints.hasDimensions = true;
        }
    }
    if (hasPromptData) {
        if (hints.hasModel && !hasWidgetNames("ckpt", "checkpoint")) {
            hints.hasModel = false;
        }
        if (hints.hasLora && !hasWidgetNames("lora")) {
            hints.hasLora = false;
        }
        if (!hints.hasGenParams && hasWidgetNames("seed", "steps", "cfg", "sampler", "scheduler")) {
            hints.hasGenParams = true;
        }
        if (hints.hasDimensions && !hasWidgetNames("height", "width")) {
            hints.hasDimensions = false;
        }
    }
    return hints;
}

function getStrictMatches(targetNode, graphCtx) {
    const nodes = graphCtx.allActiveNodes;
    const normalizeId = (id) => {
        if (typeof id === "number") return id;
        if (typeof id === "string") {
            const part = id.split(":").pop();
            return Number(part);
        }
        return NaN;
    };
    const exactMatches = nodes.filter(
        (candidate) => normalizeId(candidate.id) === normalizeId(targetNode.id) && candidate.type === targetNode.type
    );
    if (exactMatches.length > 0) {
        return exactMatches;
    }
    return exactMatches;
}
function getNodeRole(node, graphCtx, options = {}) {
    const {
        allowEmptyWidgets = false,
        allowLinkTracing = true,
        allowNoLinks = false,
    } = options;
    let score = {
        unknown: 0,
        model: 0,
        lora: 0,
        prompt: 0,
        positive: 0,
        negative: 0,
        samplerParams: 0,
        latent: 0,
    }
    const type = node?.type.toLowerCase();
    const title = node?.title?.toLowerCase();
    const widgetValues = analyzeWidgets(node, graphCtx);
    const hasWidgetsStrings = node.widgets_values?.some(v => /[\w\d]/.test(v));
    const hasOutLinks = node.outputs.some(o => o.links !== null && o.links.length);
    let downstream = { reachesPositive: false, reachesNegative: false };
    if (allowLinkTracing) { downstream = getDownstreamSignals(node, graphCtx) };
    const nodeHasAnyKeyword = (keywords, ...fields) =>
        fields.some(v =>
            typeof v === "string" &&
            keywords.some(k => v.toLowerCase().includes(k))
        );
    const outStrings = node.outputs.flatMap(o =>
        [o.name, o.type, o.label].filter(v => typeof v === "string")
    );
    const params = ["seed", "steps", "cfg", "sampler", "scheduler", "noise"];

    if (!allowNoLinks && !hasOutLinks) return "unknown";
    if (!allowEmptyWidgets && !hasWidgetsStrings) return "unknown";

    if (widgetValues.hasModel) score.model += 1;
    if (downstream.reachesModel) score.model += 1;
    if (nodeHasAnyKeyword(["checkpoint", "ckpt", "model"], title, type, ...outStrings)) score.model += 1;

    if (widgetValues.hasLora) score.lora += 1;
    if (downstream.reachesModel) score.lora += 1;
    if (nodeHasAnyKeyword(["lora"], title, type, ...outStrings)) score.lora += 1;

    if (widgetValues.hasPositive) { score.positive += 1, score.prompt -= 1 } else score.positive -= 1;
    if (downstream.reachesPositive) score.positive += 1;
    if (nodeHasAnyKeyword(["positive"], title, type)) score.positive += 3;

    if (widgetValues.hasNegative) { score.negative += 1, score.prompt -= 1 } else score.negative -= 1;
    if (downstream.reachesNegative) score.negative += 1;
    if (nodeHasAnyKeyword(["negative"], title, type)) score.negative += 3;

    if (widgetValues.hasPrompt && !widgetValues.hasPositive && !widgetValues.hasNegative) score.prompt += 1;
    if (nodeHasAnyKeyword(["string", "conditioning", "prompt"], title, type)) score.prompt += 1;

    if (widgetValues.hasGenParams) score.samplerParams += 1;
    if (downstream.reachesSampler) score.samplerParams += 1;
    if (nodeHasAnyKeyword(params, title, type)) score.samplerParams += 1;

    if (widgetValues.hasDimensions) { score.latent += 1 } else score.latent -= 1;
    if (downstream.reachesLatent) score.latent += 1;
    if (nodeHasAnyKeyword(["latent"], title, type, ...outStrings)) score.latent += 1;

    const result = Object.entries(score).reduce(
        (max, curr) =>
            curr[1] > max[1] ? curr : max);
    return { role: result[0], score: result[1] };
}
function getRoleMatches(targetNode, graphCtx) {
    const options = {
        allowEmptyWidgets: true,
        allowLinkTracing: false,
        allowNoLinks: true
    };
    const targetRole = getNodeRole(targetNode, graphCtx, options).role;
    if (!targetRole || targetRole === "unknown") {
        return [];
    }
    const candidateNodes = (graphCtx.allActiveNodes || []).filter(candidate => {
        const candidateRole = getNodeRole(candidate, graphCtx).role;
        if (candidateRole === targetRole) {
            return true;
        }
        if (
            targetRole === "prompt" &&
            (candidateRole === "positive" || candidateRole === "negative")
        ) {
            return true;
        }
        return false;
    });

    return candidateNodes;
}

async function chooseNodeFromCandidates(candidates, e) {
    return new Promise((resolve) => {
        const existing = document.getElementById("rgthree-primitive-import-menu");
        if (existing) existing.remove();
        const overlay = document.createElement("div");
        overlay.id = "rgthree-primitive-import-menu";
        overlay.style.position = "fixed";
        overlay.style.zIndex = "100000";
        overlay.style.left = `${Math.max(8, e.clientX || 8)}px`;
        overlay.style.top = `${Math.max(8, e.clientY || 8)}px`;
        overlay.style.maxWidth = "520px";
        overlay.style.maxHeight = "70vh";
        overlay.style.overflow = "auto";
        overlay.style.background = "#1f1f1f";
        overlay.style.border = "1px solid #4a4a4a";
        overlay.style.borderRadius = "8px";
        overlay.style.boxShadow = "0 8px 24px rgba(0,0,0,.35)";
        overlay.style.padding = "8px";
        const title = document.createElement("div");
        title.textContent = "[rgthree-comfy] Select node to import values from";
        title.style.color = "#ddd";
        title.style.fontSize = "12px";
        title.style.marginBottom = "6px";
        overlay.appendChild(title);
        const ROLE_COLORS = {
            latent: "#ff66cc",
            model: "#a855f7",
            lora: "#55f7a8",
            positive: "#22c55e",
            negative: "#ef4444",
            samplerParams: "#eab308",
            prompt: "#ea4208",
            unknown: "#444"
        };
        const closeMenu = (selectedNode) => {
            window.removeEventListener("mousedown", onOutsideClick, true);
            window.removeEventListener("keydown", onKeydown, true);
            overlay.remove();
            resolve(selectedNode);
        };
        const onOutsideClick = (evt) => {
            if (!overlay.contains(evt.target)) closeMenu(null);
        };
        const onKeydown = (evt) => {
            if (evt.key === "Escape") closeMenu(null);
        };
        for (const { node, role, score } of candidates) {
            const container = document.createElement("button");
            container.type = "button";
            container.style.display = "block";
            container.style.width = "100%";
            container.style.marginBottom = "8px";
            container.style.padding = "8px";
            container.style.textAlign = "left";
            container.style.background = "#151515";
            container.style.color = "#f0f0f0";
            container.style.border = "1px solid #555";
            container.style.borderLeft = `4px solid ${ROLE_COLORS[role] || ROLE_COLORS.unknown}`;
            container.style.borderRadius = "6px";
            container.style.cursor = "pointer";
            container.style.fontFamily = "monospace";
            const header = document.createElement("div");
            header.style.fontWeight = "bold";
            header.style.marginBottom = "4px";
            header.textContent = `${toNodeLabel(node)} [${role}]-${score}`;
            container.appendChild(header);
            const values = node.widgets_values || [];
            const widgetList = document.createElement("div");
            widgetList.style.fontSize = "11px";
            widgetList.style.maxHeight = "120px";
            widgetList.style.overflow = "auto";
            widgetList.style.marginBottom = "4px";
            let hasWidgets = false;
            for (let i = 0; i < values.length; i++) {
                const val = values[i];
                if (val === undefined || val === null) continue;
                let text = String(val).trim();
                if (text === "") continue;
                hasWidgets = true;
                const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
                const line = document.createElement("div");
                line.textContent = `[${i}]: ${preview}`;
                line.style.whiteSpace = "pre-wrap";
                line.style.wordBreak = "break-all";
                widgetList.appendChild(line);
            }
            if (!hasWidgets) {
                widgetList.textContent = "(no widget values)";
            }
            container.appendChild(widgetList);
            container.addEventListener("click", () => closeMenu(node));
            overlay.appendChild(container);
        }
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.style.display = "block";
        cancel.style.width = "100%";
        cancel.style.padding = "8px";
        cancel.style.background = "#1a1a1a";
        cancel.style.color = "#ccc";
        cancel.style.border = "1px solid #3f3f3f";
        cancel.style.borderRadius = "6px";
        cancel.style.cursor = "pointer";
        cancel.addEventListener("click", () => closeMenu(null));
        overlay.appendChild(cancel);
        document.body.appendChild(overlay);
        setTimeout(() => {
            window.addEventListener("mousedown", onOutsideClick, true);
            window.addEventListener("keydown", onKeydown, true);
        }, 0);
    });
}

function applyCandidateToNode(targetNode, candidateNode) {
    const next = [...(targetNode.widgets_values || [])];
    const incoming = candidateNode?.widgets_values || [];
    for (let i = 0; i < incoming.length; i++) {
        if (Array.isArray(next[i]) && Array.isArray(incoming[i])) {
            next[i] = [...incoming[i]];
        }
        else if (
            typeof next[i] === "object" && next[i] !== null &&
            typeof incoming[i] === "object" && incoming[i] !== null &&
            !Array.isArray(next[i]) && !Array.isArray(incoming[i])
        ) {
            next[i] = { ...next[i], ...incoming[i] };
        }
        else {
            next[i] = incoming[i];
        }
    }
    next.length = incoming.length;
    targetNode.configure({
        title: targetNode.title,
        widgets_values: next
    });
}

export async function importIndividualNodesInnerOnDragDrop(node, e) {
    if (!node.widgets?.length || !CONFIG_SERVICE.getFeatureValue("import_individual_nodes.enabled")) {
        return false;
    }
    const { workflow, prompt } = await tryToGetWorkflowDataFromEvent(e);
    if (!workflow) return false;
    const graphCtx = buildGraphCtx(workflow, prompt);
    const strictMatches = getStrictMatches(node, graphCtx);
    const roleMatches = getRoleMatches(node, graphCtx);
    const hasWidgetValues = (n) => Array.isArray(n.widgets_values) && n.widgets_values.length > 0;
    const strictCandidates = strictMatches.filter(hasWidgetValues);
    const roleCandidates = roleMatches.filter(hasWidgetValues);
    if (strictCandidates.length === 1) {
        applyCandidateToNode(node, strictCandidates[0]);
        return true;
    }
    if (roleCandidates.length === 1) {
        applyCandidateToNode(node, roleCandidates[0]);
        return true;
    }
    if (roleCandidates.length > 1) {
        const menuItems = roleCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx).role,
            score: getNodeRole(n, graphCtx).score
        }));
        const chosen = await chooseNodeFromCandidates(menuItems, e);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false;
    }
    if (strictCandidates.length > 1) {
        const menuItems = strictCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx).role,
            score: getNodeRole(n, graphCtx).score
        }));
        const chosen = await chooseNodeFromCandidates(menuItems, e);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false;
    }
    return true;
}
