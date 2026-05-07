import { app } from "../../scripts/app.js";
import { tryToGetWorkflowDataFromEvent } from "../../rgthree/common/utils_workflow.js";
import { SERVICE as CONFIG_SERVICE } from "./services/config_service.js";

app.registerExtension({
    name: "rgthree.ImportIndividualNodes",
    async setup() {
        const cssUrl = new URL("./nodeMenu.css", import.meta.url).href;
        const existing = document.querySelector(`link[href="${cssUrl}"]`);
        if (existing) {
            console.log("[CSS] already loaded");
            return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = cssUrl;
        document.head.appendChild(link);
    },
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

// Модифицированное меню выбора кандидатов: теперь возвращает объект { node, action }
async function chooseNodeFromCandidates(candidates, targetNode, e, graphCtx) {
    return new Promise((resolve) => {
        const existing = document.getElementById("rgthree-primitive-import-menu");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "rgthree-primitive-import-menu";

        // --- ЛОГИКА УМНОЙ ПОЗИЦИИ ---
        document.body.appendChild(overlay); // Сначала добавляем, чтобы узнать высоту

        const menuWidth = 520; // Соответствует max-width в CSS
        const menuHeight = Math.min(window.innerHeight * 0.7, candidates.length * 150);

        let left = e.clientX || 8;
        // В блоке расчета top:
        let top = e.clientY || 8;
        const offset = 40; // Дополнительный запас в пикселях

        // Если меню не влезает по ширине — сдвигаем влево
        if (left + menuWidth > window.innerWidth) {
            left = window.innerWidth - menuWidth - 20;
        }
        // Если не влезает по высоте — сдвигаем вверх
        if (top + menuHeight > window.innerHeight) {
            top = window.innerHeight - menuHeight - offset;
        }

        overlay.style.left = `${Math.max(8, left)}px`;
        overlay.style.top = `${Math.max(8, top)}px`;

        // --- ЛОГИКА ПЕРЕТАСКИВАНИЯ (DRAG) ---
        const title = document.createElement("div");
        title.className = "rgthree-menu-title";
        title.style.cursor = "move"; // Показываем, что можно тащить
        title.textContent = "::: Select node to import values from";
        overlay.appendChild(title);

        let isDragging = false;
        let offsetX, offsetY;

        title.onmousedown = (e) => {
            isDragging = true;
            offsetX = e.clientX - overlay.offsetLeft;
            offsetY = e.clientY - overlay.offsetTop;
            title.style.background = "rgba(255, 255, 255, 0.1)"; // Визуальный отклик
        };

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            overlay.style.left = `${e.clientX - offsetX}px`;
            overlay.style.top = `${e.clientY - offsetY}px`;
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
            title.style.background = "";
        });

        const ROLE_COLORS = {
            latent: "#82366b", model: "#4e3573", lora: "#2c5c41",
            positive: "#386641", negative: "#732c2c", samplerParams: "#907130",
            prompt: "#733e2c", unknown: "#333333"
        };

        let selectedValue = null;
        let selectedWidgetEl = null;
        const mapping = {};

        // Функция нормализации ID для сабграфов ("123:456" -> "456")
        const normalizeId = (id) => {
            if (id === undefined || id === null) return null;
            const s = String(id);
            return s.includes(":") ? s.split(":").pop() : s;
        };

        const targetIdNorm = normalizeId(targetNode.id);

        // Панель прокси-ноды (целевой)
        const proxyPanel = document.createElement("div");
        proxyPanel.id = "rgthree-mapping-proxy-panel";
        proxyPanel.style.display = "none";

        const proxyTitle = document.createElement("div");
        proxyTitle.className = "rgthree-menu-title";
        proxyTitle.textContent = `Mapping to: ${targetNode.type} (ID: ${targetIdNorm})`;
        proxyPanel.appendChild(proxyTitle);

        (targetNode.widgets || []).forEach((w, idx) => {
            const slot = document.createElement("div");
            slot.className = "rgthree-proxy-slot";
            slot.textContent = w.name || `Widget ${idx}`;
            slot.onclick = () => {
                if (selectedValue !== null) {
                    mapping[idx] = selectedValue;
                    slot.classList.add("mapped");
                    slot.textContent = `✓ ${w.name || idx}`;
                    selectedValue = null;
                    if (selectedWidgetEl) selectedWidgetEl.classList.remove("selected");
                }
            };
            proxyPanel.appendChild(slot);
        });

        const btnApplyManual = document.createElement("button");
        btnApplyManual.className = "rgthree-mock-btn-apply";
        btnApplyManual.textContent = "Apply";
        btnApplyManual.onclick = () => closeMenu({ action: "manual", mapping });
        proxyPanel.appendChild(btnApplyManual);

        const closeMenu = (selectedResult, evt) => {
            if (evt) {
                evt.preventDefault();
                evt.stopPropagation();
                evt.stopImmediatePropagation();
            }

            // Вызываем нашу новую чистку
            if (overlay._cleanup) overlay._cleanup();

            overlay.remove();
            proxyPanel.remove();
            resolve(selectedResult || { action: "cancelled" });
        };

        const onOutsideClick = (e) => {
            if (!overlay.contains(e.target) && !proxyPanel.contains(e.target)) closeMenu(null, e);
        };
        const onKeydown = (e) => {
            if (e.key === "Escape") closeMenu(null, e);
        };

        const scrollBox = document.createElement("div");
        scrollBox.className = "rgthree-mock-node-container";
        overlay.appendChild(scrollBox);

        // Отрисовка кандидатов
        for (const { node, role, score } of candidates) {
            const container = document.createElement("div");
            container.className = "rgthree-mock-node";

            const header = document.createElement("div");
            header.className = "rgthree-mock-node-header";
            header.style.backgroundColor = ROLE_COLORS[role] || ROLE_COLORS.unknown;
            const label = (typeof toNodeLabel === 'function') ? toNodeLabel(node) : (node.type || 'Node');
            header.textContent = `${label} [${role}]-${score}`;
            header.onclick = (e) => closeMenu({ node, action: "direct" }, e);
            container.appendChild(header);

            const body = document.createElement("div");
            body.className = "rgthree-mock-node-body";
            body.onclick = (e) => {
                if (e.target === body) closeMenu({ node, action: "direct" }, e);
            };

            // Достаем данные из promptData Map
            let nodeInPrompt = null;
            const nodeIdNorm = normalizeId(node.id);

            if (graphCtx?.promptData instanceof Map) {
                for (let [fullId, data] of graphCtx.promptData) {
                    if (normalizeId(fullId) === nodeIdNorm) {
                        nodeInPrompt = data;
                        break;
                    }
                }
            }

            const promptInputs = nodeInPrompt?.inputs || {};
            const values = node.widgets_values || [];

            for (let i = 0; i < values.length; i++) {
                const val = values[i];
                if (val === undefined || val === null || String(val).trim() === "") continue;

                // Матчинг имени
                let widgetName = Object.keys(promptInputs).find(key => {
                    const inputVal = promptInputs[key];
                    if (Array.isArray(inputVal)) return false;
                    // Сравнение для int, float и string
                    if (typeof inputVal === 'number' && typeof val === 'number') return inputVal === val;
                    return String(inputVal) === String(val);
                });

                if (!widgetName) widgetName = `widgtet[${i}]`;

                const text = String(val).trim();
                if (text === "" && !Array.isArray(val)) continue;

                const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
                const widgetLine = document.createElement("div");
                widgetLine.className = "rgthree-mock-widget";

                // Определяем класс в зависимости от типа данных
                let typeClass = "";
                if (typeof val === 'number') {
                    typeClass = "type-number"; // Для int и float
                } else if (typeof val === 'string') {
                    typeClass = "type-string"; // Для строк
                }

                widgetLine.innerHTML = `<span class="widget-label">${widgetName}:</span> <span class="widget-value ${typeClass}">${preview}</span>`;

                widgetLine.onclick = (evt) => {
                    evt.stopPropagation();
                    overlay.querySelectorAll('.rgthree-mock-widget').forEach(el => el.classList.remove('selected'));
                    widgetLine.classList.add("selected");
                    selectedValue = val;

                    const menuRect = overlay.getBoundingClientRect();
                    proxyPanel.style.display = "block";
                    proxyPanel.style.left = `${menuRect.right + 20}px`;
                    proxyPanel.style.top = `${menuRect.top}px`;
                };

                body.appendChild(widgetLine);
            }

            if (body.children.length === 0) {
                const emptyMsg = document.createElement("div");
                emptyMsg.className = "rgthree-mock-widget-empty";
                emptyMsg.textContent = "(no widget values)";
                body.appendChild(emptyMsg);
            }

            container.appendChild(body);
            scrollBox.appendChild(container);
        }

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "rgthree-mock-btn-cancel";
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = (e) => closeMenu(null, e);
        overlay.appendChild(cancelBtn);

        document.body.appendChild(overlay);
        document.body.appendChild(proxyPanel);

        setTimeout(() => {
            const onOutsideClick = (evt) => {
                // Проверяем, попал ли клик внутрь основного меню или прокси-панели
                const isInsideMenu = overlay.contains(evt.target);
                const isInsideProxy = proxyPanel.contains(evt.target);

                if (!isInsideMenu && !isInsideProxy) {
                    // Если клик вне — убиваем событие и закрываем
                    evt.preventDefault();
                    evt.stopPropagation();
                    evt.stopImmediatePropagation();
                    closeMenu({ action: "cancelled" }, evt);
                }
            };

            const onKeydown = (evt) => {
                if (evt.key === "Escape") {
                    closeMenu({ action: "cancelled" }, evt);
                }
            };

            // Слушаем на стадии захвата (true), чтобы быть первыми
            window.addEventListener("pointerdown", onOutsideClick, true);
            window.addEventListener("keydown", onKeydown, true);

            // Чистим слушатели при закрытии
            overlay._cleanup = () => {
                window.removeEventListener("pointerdown", onOutsideClick, true);
                window.removeEventListener("keydown", onKeydown, true);
            };
        }, 0);
    });
}

function applyCandidateToNode(targetNode, result) {
    if (!result) return;

    // Определяем, пришла ли нам просто нода (авто-вставка) или объект из меню
    const isManual = result.action === "manual";
    const sourceNode = result.node || (result.widgets_values ? result : null);

    let next = [...(targetNode.widgets_values || [])];

    // СЛУЧАЙ 1: Ручной маппинг из нашего нового меню
    if (isManual && result.mapping) {
        for (const [idx, value] of Object.entries(result.mapping)) {
            next[parseInt(idx)] = value;
        }
    }
    // СЛУЧАЙ 2: Твоя оригинальная логика (прямой импорт ноды)
    else if (sourceNode) {
        const incoming = sourceNode.widgets_values || [];
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
    }

    // Применяем через базовый метод ComfyUI
    targetNode.configure({
        title: targetNode.title,
        widgets_values: next
    });

    // СИНХРОНИЗАЦИЯ: Чтобы значения сразу появились в полях (Lora Manager и т.д.)
    if (targetNode.widgets) {
        targetNode.widgets.forEach((w, i) => {
            if (next[i] !== undefined) {
                w.value = next[i];
                if (typeof w.callback === "function") {
                    w.callback(next[i]);
                }
            }
        });
    }

    if (targetNode.setDirtyCanvas) {
        targetNode.setDirtyCanvas(true, true);
    }
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

    // Авто-вставка (Strict)
    if (strictCandidates.length === 1) {
        applyCandidateToNode(node, strictCandidates[0]);
        return true;
    }

    // Авто-вставка (Role)
    if (roleCandidates.length === 1) {
        applyCandidateToNode(node, roleCandidates[0]);
        return true;
    }

    // Выбор из нескольких по Роли
    if (roleCandidates.length > 1) {
        const menuItems = roleCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx).role,
            score: getNodeRole(n, graphCtx).score
        }));
        // ПЕРЕДАЕМ контекст для отрисовки превью
        const chosen = await chooseNodeFromCandidates(menuItems, node, e, graphCtx);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false;
    }

    // Выбор из нескольких Strict
    if (strictCandidates.length > 1) {
        const menuItems = strictCandidates.map(n => ({
            node: n,
            role: getNodeRole(n, graphCtx).role,
            score: getNodeRole(n, graphCtx).score
        }));
        // ПЕРЕДАЕМ контекст для отрисовки превью
        const chosen = await chooseNodeFromCandidates(menuItems, node, e, graphCtx);
        if (chosen) {
            applyCandidateToNode(node, chosen);
            return true;
        }
        return false;
    }

    return true;
}
