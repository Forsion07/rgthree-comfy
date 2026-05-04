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
function normalizeText(value) {
    return `${value !== null && value !== void 0 ? value : ""}`.trim().toLowerCase();
}
function toNodeLabel(node) {
    return `${node.title || node.type || "Node"}${node.id != null ? ` #${node.id}` : ""}`;
}
function buildGraphContext(workflow, prompt) {
    const nodes = workflow?.nodes ?? [];
    const promptData = new Map(
        Object.entries(prompt ?? {}).map(([k, v]) => [
            isNaN(k) ? k : Number(k),
            v
        ])
    );
    const subgraphs = workflow?.definitions?.subgraphs ?? [];

    // Сопоставляем внешнюю ноду-сабграф с её определением
    const subgraphByNodeId = new Map();
    for (const node of nodes) {
        const sub = subgraphs.find(sg => sg.id === node.type);
        if (sub) {
            subgraphByNodeId.set(node.id, { node, sub });
        }
    }

    const allNodes = [];
    const allLinks = []; // итоговые объекты связей

    const idMap = new Map();        // старый id узла → новый id (внутренние ноды)
    const linkIdRemap = new Map();  // старый id связи → новый id связи

    // ---------- 1. Внешние узлы (не сабграфы) ----------
    for (const node of nodes) {
        if (subgraphByNodeId.has(node.id)) continue;
        allNodes.push({ ...node });
    }

    // ---------- 2. Внутренние узлы сабграфов ----------
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

    // ---------- 3. Обработка внешних связей с перенаправлением ----------
    const externalLinks = Array.isArray(workflow?.links) ? workflow.links : [];
    const allIds = [...allLinks.map(l => l.id), ...externalLinks.map(l => l[0])];
    let nextLinkId = Math.max(...allIds, 0) + 1;

    for (const rawLink of externalLinks) {
        if (!Array.isArray(rawLink) || rawLink.length < 5) continue;

        const linkObj = {
            id: rawLink[0],
            origin_id: rawLink[1],
            origin_slot: rawLink[2],
            target_id: rawLink[3],
            target_slot: rawLink[4],
            type: rawLink[5],
        };

        const originIsSubgraph = subgraphByNodeId.has(linkObj.origin_id);
        const targetIsSubgraph = subgraphByNodeId.has(linkObj.target_id);

        // Если оба конца — не сабграфы, просто добавляем
        if (!originIsSubgraph && !targetIsSubgraph) {
            allLinks.push(linkObj);
            continue;
        }

        // Собираем внутренние связи для origin (выход из сабграфа)
        let originInnerLinks = [];
        if (originIsSubgraph) {
            const { sub } = subgraphByNodeId.get(linkObj.origin_id);
            originInnerLinks = (sub.links || []).filter(l => {
                const tId = Array.isArray(l) ? l[3] : l.target_id;
                const tSlot = Array.isArray(l) ? l[4] : l.target_slot;
                return tId === -20 && tSlot === linkObj.origin_slot;
            }).map(l => Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : { ...l });
            if (originInnerLinks.length === 0) continue;
        } else {
            // Если origin не сабграф, создаём один фиктивный внутренний линк для унификации
            originInnerLinks = [linkObj];
        }

        // Собираем внутренние связи для target (вход в сабграф)
        let targetInnerLinks = [];
        if (targetIsSubgraph) {
            const { sub } = subgraphByNodeId.get(linkObj.target_id);
            targetInnerLinks = (sub.links || []).filter(l => {
                const oId = Array.isArray(l) ? l[1] : l.origin_id;
                const oSlot = Array.isArray(l) ? l[2] : l.origin_slot;
                return oId === -10 && oSlot === linkObj.target_slot;
            }).map(l => Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : { ...l });
            if (targetInnerLinks.length === 0) continue;
        } else {
            targetInnerLinks = [linkObj];
        }

        // Декартово произведение: для каждой комбинации создаём уникальную связь
        for (const oLink of originInnerLinks) {
            for (const tLink of targetInnerLinks) {
                const newId = nextLinkId++;
                const resolved = {
                    id: newId,
                    origin_id: originIsSubgraph ? (idMap.get(String(oLink.origin_id)) ?? oLink.origin_id) : linkObj.origin_id,
                    origin_slot: originIsSubgraph ? oLink.origin_slot : linkObj.origin_slot,
                    target_id: targetIsSubgraph ? (idMap.get(String(tLink.target_id)) ?? tLink.target_id) : linkObj.target_id,
                    target_slot: targetIsSubgraph ? tLink.target_slot : linkObj.target_slot,
                    type: originIsSubgraph ? oLink.type : tLink.type, // предпочитаем тип из сабграфа, если есть
                };

                if (originIsSubgraph && targetIsSubgraph) {
                    resolved.type = oLink.type; // или tLink.type, они должны совпадать
                }

                allLinks.push(resolved);

                // Маппим старые внутренние id на новый
                if (originIsSubgraph) linkIdRemap.set(oLink.id, newId);
                if (targetIsSubgraph) linkIdRemap.set(tLink.id, newId);
            }
        }
    }

    // ---------- 4. Добавляем внутренние связи сабграфов, не затронутые перенаправлением ----------
    for (const [, { sub }] of subgraphByNodeId.entries()) {
        if (!sub.links) continue;
        for (const rawLink of sub.links) {
            const link = Array.isArray(rawLink)
                ? { id: rawLink[0], origin_id: rawLink[1], origin_slot: rawLink[2], target_id: rawLink[3], target_slot: rawLink[4], type: rawLink[5] }
                : { ...rawLink };

            // Пропускаем связи, которые уже были заменены внешними
            if (linkIdRemap.has(link.id)) continue;

            // Заменяем id узлов, если они переехали
            if (idMap.has(String(link.origin_id))) link.origin_id = idMap.get(String(link.origin_id));
            if (idMap.has(String(link.target_id))) link.target_id = idMap.get(String(link.target_id));

            // Пропускаем всё ещё фиктивные связи
            if (link.origin_id === -10 || link.target_id === -20) continue;

            allLinks.push(link);
        }
    }

    // ---------- 5. Удаляем связи с -10/-20 (на всякий случай, если что-то проскользнуло) ----------
    const filteredLinks = allLinks.filter(link => link.origin_id !== -10 && link.target_id !== -20);

    // ---------- 6. Обновляем ссылки в inputs/outputs нод ----------
    for (const node of allNodes) {
        if (node.outputs) {
            for (const output of node.outputs) {
                if (Array.isArray(output.links)) {
                    output.links = output.links.map(lid => linkIdRemap.get(lid) ?? lid);
                }
            }
        }
        if (node.inputs) {
            for (const input of node.inputs) {
                if (input.link != null && linkIdRemap.has(input.link)) {
                    input.link = linkIdRemap.get(input.link);
                }
            }
        }
    }

    // ---------- 7. Строим карты графа ----------
    const nodesById = new Map(allNodes.map(n => [n.id, n]));
    const incomingByNodeId = new Map();
    const outgoingByNodeId = new Map();

    function addEdge(edge) {
        if (!outgoingByNodeId.has(edge.originNodeId)) outgoingByNodeId.set(edge.originNodeId, []);
        if (!incomingByNodeId.has(edge.targetNodeId)) incomingByNodeId.set(edge.targetNodeId, []);
        outgoingByNodeId.get(edge.originNodeId).push(edge);
        incomingByNodeId.get(edge.targetNodeId).push(edge);
    }

    for (const link of filteredLinks) {
        const originNode = nodesById.get(link.origin_id);
        const targetNode = nodesById.get(link.target_id);

        const edge = {
            originNodeId: link.origin_id,
            targetNodeId: link.target_id,
            linktype: link.type,
            sourceOutputName: normalizeText(originNode?.outputs?.[link.origin_slot]?.name),
            targetInputName: normalizeText(targetNode?.inputs?.[link.target_slot]?.name),
            originType: normalizeText(originNode?.type),
            targetType: normalizeText(targetNode?.type),
            dataType: null,
        };
        addEdge(edge);
    }

    return {
        nodes: allNodes,
        promptData,
        nodesById,
        normalLinks: filteredLinks,     // массив объектов связей
        incomingByNodeId,
        outgoingByNodeId,
    };
}
function buildRawGraphCtx(workflow, prompt) {
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
    const subs = workflow.definitions.subgraphs;
    const subsById = new Map(workflow.definitions.subgraphs.map(s => [s.id, s]));
    const subsNodes = subs.flatMap(n => n.nodes);
    const subsLinks = subs.flatMap(l => l.links);
    const subsNodesById = new Map(subsNodes.map(n => [n.id, n]));
    const subsLinksById = new Map(subsLinks.map(l => [l.id, l]));
    const subsProxyNodes = workflow.nodes.filter(n => subsById.has(n.type));
    const subsProxyNodesById = new Map(subsProxyNodes.map(n => [n.id, n]));
    const subsProxyNodesByType = new Map(subsProxyNodes.map(n => [n.type, n]));
    const subgraphByNodeId = new Map();
    for (const node of nodes) {
        const sub = subs.find(sg => sg.id === node.type);
        if (sub) {
            subgraphByNodeId.set(node.id, { node, sub });
        }
    }
    const allNodes = [];
    const idMap = new Map();        // старый id узла → новый id
    for (const node of nodes) {
        if (subgraphByNodeId.has(node.id)) continue;
        allNodes.push({ ...node });
    }

    // 2. Внутренние узлы сабграфов
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
function getDownstreamSignals(startNode, graphCtx, maxDepth = 4) {
    const queue = [{ nodeId: startNode.id, depth: 0, path: [startNode.id] }];
    const visited = new Set([startNode.id]);
    const signals = {
        reachesPositive: false,
        reachesNegative: false,
        reachesModel: false,
        reachesLatent: false,
        reachesSampler: false,
        positivePath: null,
        negativePath: null,
        modelPath: null,
        latentPath: null,
    };

    while (queue.length) {
        const current = queue.shift();
        if (!current || current.depth >= maxDepth) continue;

        const currentNode = graphCtx.nodesById.get(current.nodeId);

        // Если текущая нода bypassed – просто пробрасываем все её выходы, не анализируя сигналы
        if (currentNode && currentNode.mode === 4) {
            const outgoing = graphCtx.outgoingByNodeId.get(currentNode.id) || [];
            for (const edge of outgoing) {
                const targetNode = graphCtx.nodesById.get(edge.targetNodeId);
                if (targetNode && !visited.has(edge.targetNodeId)) {
                    visited.add(edge.targetNodeId);
                    queue.push({
                        nodeId: edge.targetNodeId,
                        depth: current.depth + 1,
                        path: [...current.path, edge.targetNodeId],
                    });
                }
            }
            continue;
        }

        const outgoing = (graphCtx.outgoingByNodeId.get(current.nodeId) ?? [])
        for (const edge of outgoing) {
            const targetNode = graphCtx.nodesById.get(edge.targetNodeId);

            // Если целевая нода bypassed – сразу проходим сквозь неё
            if (targetNode && targetNode.mode === 4) {
                if (!visited.has(edge.targetNodeId)) {
                    visited.add(edge.targetNodeId);
                    const bypassedOutgoing = graphCtx.outgoingByNodeId.get(edge.targetNodeId) || [];
                    for (const bypassedEdge of bypassedOutgoing) {
                        if (!visited.has(bypassedEdge.targetNodeId)) {
                            visited.add(bypassedEdge.targetNodeId);
                            queue.push({
                                nodeId: bypassedEdge.targetNodeId,
                                depth: current.depth + 1,
                                path: [...current.path, edge.targetNodeId, bypassedEdge.targetNodeId],
                            });
                        }
                    }
                }
                continue; // не проверяем сигналы для bypassed
            }

            // Обычная проверка для активных нод
            if (edge.targetInputName === "positive" && edge.linktype === "CONDITIONING") {
                signals.reachesPositive = true;
                if (!signals.positivePath) signals.positivePath = [...current.path, edge.targetNodeId];
            }
            if (edge.targetInputName === "negative" && edge.linktype === "CONDITIONING") {
                signals.reachesNegative = true;
                if (!signals.negativePath) signals.negativePath = [...current.path, edge.targetNodeId];
            }
            if (edge.targetInputName === "model" || edge.linktype === "MODEL") {
                signals.reachesModel = true;
                if (!signals.modelPath) signals.modelPath = [...current.path, edge.targetNodeId];
            }
            if (edge.targetInputName === "latent_image" && edge.linktype === "LATENT") {
                signals.reachesLatent = true;
                if (!signals.latentPath) signals.latentPath = [...current.path, edge.targetNodeId];
            }
            if (
                (edge.targetType || "").includes("sampler") &&
                edge.linktype === "COMBO" ||
                edge.linktype === "FLOAT" ||
                edge.linktype === "INT"
            ) {
                signals.reachesSampler = true;
            }

            if (!visited.has(edge.targetNodeId)) {
                visited.add(edge.targetNodeId);
                queue.push({
                    nodeId: edge.targetNodeId,
                    depth: current.depth + 1,
                    path: [...current.path, edge.targetNodeId],
                });
            }
        }
    }
    return signals;
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
function traceDownstream(startNode, graphCtx) {
    //startNode = graphCtx.nodesById.get(startNode.id) ? graphCtx.subsNodesById.get(startNode.id) : {};
    const queue = [startNode];
    const visited = new Set([startNode.id]);
    const allowedLinkTypes = ["CONDITIONING", "STRING", "MODEL", "LATENT", "INT", "FLOAT"];
    const signals = {
        reachesPositive: false,
        reachesNegative: false,
        reachesSampler: false,
    };
    while (queue.length > 0) {
        const currentNode = queue.shift();
        for (const output of currentNode.outputs) {
            if (!output.links) continue;
            const linksQueue = [...output.links];
            for (const linkId of linksQueue) {
                const link = graphCtx.linksById.get(linkId) ?? graphCtx.subsLinksById.get(linkId);
                if (!link || !allowedLinkTypes.includes(link.type)) continue;
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
                if (targetNode.mode !== 4) {
                    if (inputName.includes("positive") && currentLinkType === "CONDITIONING") {
                        signals.reachesPositive = true;
                    }
                    if (inputName.includes("negative") && currentLinkType === "CONDITIONING") {
                        signals.reachesNegative = true;
                    }
                    if (targetType.includes("sampler")) {
                        signals.reachesSampler = true;
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
    // Возвращаем объект с нулями, если это не строка
    if (typeof widgetValue !== 'string') return { pos: 0, neg: 0 };

    const text = widgetValue.toLowerCase();

    // Базовый скор (то, что присуще ЛЮБОМУ промпту: длина, запятые, веса)
    let baseScore = 0;
    let posScore = 0;
    let negScore = 0;

    // 1. Базовые проверки синтаксиса
    if (text.length > 15) baseScore += 1;
    if (text.length > 50) baseScore += 1;

    // Синтаксис весов (бывает и там, и там, но это точно промпт)
    if (/\([\w\s,.-]+:\d*\.?\d+\)/.test(text)) baseScore += 2;
    if (/\[[\w\s,.-]+\]/.test(text)) baseScore += 1;
    if (/\([\w\s,.-]+\)/.test(text)) baseScore += 1;
    if (/\\\([\w\s]+\\\)/.test(text)) posScore += 2, negScore += 1;

    // Запятые
    const commaCount = (text.match(/,/g) || []).length;
    if (commaCount >= 3) baseScore += 2;

    // 2. Индикаторы ПОЗИТИВНОГО промпта
    if (/<lora:[^:]+:\d*\.?\d+>/.test(text)) posScore += 1;

    const posMarkers = [
        'masterpiece', 'best quality', 'highres', 'painting',
        'realistic', '1girl', '1boy', '4k', '8k', 'raw photo', 'cinematic'
    ];
    for (const marker of posMarkers) {
        if (text.includes(marker)) posScore += 1;
    }

    // 3. Индикаторы НЕГАТИВНОГО промпта
    const negMarkers = [
        'worst quality', 'lowres', 'bad quality', 'low quality', 'normal quality',
        'bad anatomy', 'bad hands', 'missing fingers', 'extra digit', 'fewer digits',
        'mutated', 'deformed', 'ugly', 'poorly drawn',
        'cropped', 'watermark', 'signature', 'text', 'username', 'jpeg artifacts', 'blurry'
    ];
    for (const marker of negMarkers) {
        // Даем больший вес негативным маркерам, так как они очень специфичны
        if (text.includes(marker)) negScore += 2;
    }

    // Проверка на частые негативные эмбеддинги
    if (text.includes('easynegative') || text.includes('badhand')) negScore += 3;
    if (/embedding:.*(neg|bad).*/.test(text)) negScore += 2;

    // 4. Пенальти (если это JSON или путь к файлу)
    if (text.includes('{') && text.includes('}')) baseScore -= 5;
    if (/^[a-zA-Z0-9_/\\]+\.(safetensors|ckpt|pt|pth|bin)$/i.test(text)) baseScore -= 5;

    // 5. Итоговый подсчет
    // Прибавляем базовый скор (уверенность, что это вообще промпт) к полярностям
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
    // Защита от нод без виджетов
    if (!node.widgets_values || !Array.isArray(node.widgets_values)) {
        return hints;
    }

    for (const value of node.widgets_values) {
        const positive = asumePrompt(value).pos;
        const negative = asumePrompt(value).neg;
        // --- 1. Проверка на модели ---
        if (typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|sft)$/i.test(value)) {
            hints.hasModel = true;
        }
        if (typeof value === 'string' && /(\.safetensors|lora)/i.test(value)) {
            hints.hasLora = true;
        }
        // --- 2. Проверка на промпт ---
        if (positive >= 3 && positive > negative) {
            hints.hasPositive = true;
        }
        if (negative >= 3 && positive < negative) {
            hints.hasNegative = true;
        }
        if (positive >= 3 || negative >= 3) {
            hints.hasPrompt = true;
        }

        // --- 3. Проверка на параметры генерации (seed, cfg, steps) ---
        // Seed обычно очень большое число
        // if (typeof value === 'number' && Number.isInteger(value) && value > 100000) {
        //     hints.hasGenParams = true; // Скорее всего это seed
        // }
        // CFG обычно float от 1 до 30, Steps от 1 до 150
        // (определить их только по значению сложно, но можно проверять названия виджетов, если доступно node.widgets)

        // Поиск сэмплеров/скедулеров (строковые имена)
        if (typeof value === 'string') {
            const samplers = ['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim', 'lms'];
            const schedulers = ['normal', 'simple', 'karras', 'exponential', 'sgm_uniform', 'ddim'];
            if (/(euler|dpmpp|ddim|lms)/i.test(value) || /(normal|simple|karras|exponential|sgm|ddim)/i.test(value)) {
                hints.hasGenParams = true;
            }
        }

        // --- 4. Проверка на габариты (Dimensions) ---
        // Стандартные разрешения или просто числа кратные 8 (обычно от 256 до 4096)
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
        if (!hints.hasGenParams && hasWidgetNames("seed", "steps", "cfg", "sampler")) {
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
    return exactMatches; //nodes.filter((candidate) => candidate.type === targetNode.type);
}
function getNodeRole(node, graphCtx, options = {}) {
    const {
        allowEmptyWidgets = false,
        allowLinkTracing = true,
        allowNoLinks = false,
    } = options;
    let score = {
        model: 0,
        lora: 0,
        positive: 0,
        negative: 0,
        prompt: 0,
        samplerParams: 0,
        latent: 0,
    }
    const type = normalizeText(node.type);
    const title = normalizeText(node.title);
    const widgetValues = analyzeWidgets(node, graphCtx);
    const hasWidgetsStrings = node.widgets_values?.some(v => typeof v === "string" && v !== "");
    const hasOutLinks = node.outputs.some(o => o.links !== null && o.links.length);
    let downstream = { reachesPositive: false, reachesNegative: false };
    if (allowLinkTracing) { downstream = traceDownstream(node, graphCtx) };
    const nodeHasAnyKeyword = (keywords, ...fields) =>
        fields.some(v =>
            typeof v === "string" &&
            keywords.some(k => v.toLowerCase().includes(k))
        );
    const outStrings = node.outputs.flatMap(o =>
        [o.name, o.type, o.label].filter(v => typeof v === "string")
    );
    const insStrings = node.inputs.flatMap(o =>
        [o.name, o.type, o.label].filter(v => typeof v === "string")
    );
    const hasWidget = (content) => JSON.stringify(node.widgets_values).toLowerCase().includes(content);
    const params = ["seed", "steps", "cfg", "sampler"];

    if (!allowNoLinks && !hasOutLinks) return "unknown";
    if (!allowEmptyWidgets && !hasWidgetsStrings) return "unknown";

    if (widgetValues.hasModel) score.model += 2;
    if (downstream.reachesModel) score.model += 1;
    if (nodeHasAnyKeyword(["checkpoint", "ckpt"], title, type)) score.model += 1;

    if (widgetValues.hasLora) score.lora += 1;
    if (downstream.reachesModel) score.lora += 1;
    if (nodeHasAnyKeyword(["lora"], title, type, ...outStrings)) score.lora += 2;

    if (widgetValues.hasPositive) score.positive += 2;
    if (downstream.reachesPositive) score.positive += 1;
    if (nodeHasAnyKeyword(["positive"], title, type, ...outStrings)) score.positive += 1;

    if (widgetValues.hasNegative) score.negative += 2;
    if (downstream.reachesNegative) score.negative += 1;
    if (nodeHasAnyKeyword(["negative"], title, type, ...outStrings)) score.negative += 1;

    if (downstream.reachesPositive || downstream.reachesNegative) score.prompt += 1;
    if (nodeHasAnyKeyword(["string", "conditioning", "prompt"], title, type)) score.prompt += 1;

    if (widgetValues.hasGenParams) score.samplerParams += 1;
    if (downstream.reachesSampler) score.samplerParams += 1;
    if (nodeHasAnyKeyword(params, title, type)) score.samplerParams += 1;

    if (widgetValues.hasDimensions) score.latent += 1;
    if (downstream.reachesSampler) score.latent += 1;
    if (nodeHasAnyKeyword(["latent"], title, type, ...outStrings)) score.latent += 1;

    if (score.model >= 2 && score.model > score.lora) return "model_provider";
    if (score.lora >= 2) return "lora_provider";
    if (score.positive >= 2 && score.positive > score.negative) return "prompt_positive";
    if (score.negative >= 2 && score.negative > score.positive) return "prompt_negative";
    if (score.prompt >= 1) return "prompt_possible";
    if (score.samplerParams >= 2) return "sampler_params";
    if (score.latent >= 2) return "latent_source";

    return "unknown";
}
function getRoleMatches(targetNode, graphCtx) {
    const options = {
        allowEmptyWidgets: true,
        allowLinkTracing: false,
        allowNoLinks: true
    };
    const targetRole = getNodeRole(targetNode, graphCtx, options);

    // Если роль не определена, вернуть пустой массив
    if (!targetRole || targetRole === "unknown") {
        return [];
    }

    // Базовое условие: роль кандидата должна совпадать
    const candidateNodes = (graphCtx.allActiveNodes || []).filter(candidate => {
        const candidateRole = getNodeRole(candidate, graphCtx);
        if (candidateRole === targetRole) {
            return true;
        }
        // Для положительного/отрицательного промпта также принимаем possible
        if (
            targetRole === "prompt_possible" &&
            (candidateRole === "prompt_positive" || candidateRole === "prompt_negative")
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
            latent_source: "#ff66cc",
            model_provider: "#a855f7",
            lora_provider: "#55f7a8",
            prompt_positive: "#22c55e",
            prompt_negative: "#ef4444",
            sampler_params: "#eab308",
            prompt_possible: "#ea4208",
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

        for (const { node, role } of candidates) {
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

            // Заголовок: имя ноды и роль
            const header = document.createElement("div");
            header.style.fontWeight = "bold";
            header.style.marginBottom = "4px";
            header.textContent = `${toNodeLabel(node)} [${role}]`;
            container.appendChild(header);

            // Список непустых значений виджетов
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
        // массивы заменяем полностью
        if (Array.isArray(next[i]) && Array.isArray(incoming[i])) {
            next[i] = [...incoming[i]]; // или просто incoming[i], если не боимся мутаций
        }
        // обычные объекты (не массивы) — сливаем
        else if (
            typeof next[i] === "object" && next[i] !== null &&
            typeof incoming[i] === "object" && incoming[i] !== null &&
            !Array.isArray(next[i]) && !Array.isArray(incoming[i])
        ) {
            next[i] = { ...next[i], ...incoming[i] };
        }
        // всё остальное — просто перезаписываем
        else {
            next[i] = incoming[i];
        }
    }

    // обрезаем лишние виджеты, если у target их было больше
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

    //const graphCtx = buildGraphContext(workflow, prompt);
    // const isActive = (n) => n.mode !== 4; // исключаем bypassed
    // const activeNodes = graphCtx?.nodes.filter(isActive) ?? [];
    const graphCtx = buildRawGraphCtx(workflow, prompt);


    // Шаг 1: получаем сырые совпадения
    const strictMatches = getStrictMatches(node, graphCtx);
    const roleMatches = getRoleMatches(node, graphCtx);

    // Вспомогательная: проверка, что у ноды есть непустые widgets_values
    const hasWidgetValues = (n) => Array.isArray(n.widgets_values) && n.widgets_values.length > 0;

    // Очищаем оба массива от нод без значений
    const strictCandidates = strictMatches.filter(hasWidgetValues);
    const roleCandidates = roleMatches.filter(hasWidgetValues);

    // Шаг 2: применяем strict-кандидата, если он единственный
    if (strictCandidates.length === 1) {
        applyCandidateToNode(node, strictCandidates[0]);
        return true;
    }

    // Шаг 3: применяем role-кандидата, если он единственный (и нет strict с length 1)
    if (roleCandidates.length === 1) {
        applyCandidateToNode(node, roleCandidates[0]);
        return true;
    }

    // Шаг 4: если есть несколько role-кандидатов – показываем меню с ними
    if (roleCandidates.length > 1) {
        const menuItems = roleCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx)
        }));
        const chosen = await chooseNodeFromCandidates(menuItems, e);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false; // пользователь отменил
    }

    // Шаг 5: если role-кандидатов нет, но есть несколько strict-кандидатов – показываем меню с ними
    if (strictCandidates.length > 1) {
        const menuItems = strictCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx)
        }));
        const chosen = await chooseNodeFromCandidates(menuItems, e);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false;
    }

    // Во всех остальных случаях (нет кандидатов) даём стандартному поведению сработать
    return true;
}
