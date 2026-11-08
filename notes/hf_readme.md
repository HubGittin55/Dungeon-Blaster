---
license: apache-2.0
tags:
- uncensored
- qwen3.6
- moe
- gguf
- vision
- multimodal
- genesis
- hermes
- agentic
language:
- en
- zh
- multilingual
datasets:
- NousResearch/hermes-function-calling-v1
pipeline_tag: image-text-to-text
base_model:
- HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive
---

# 🌟 Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive -> Genesis Hermes

> ⚡ If you like this Genesis LLM release you can donate to me via [Hipolink](https://hipolink.net/luffythefox) or:

> USDT (TRC20): `TGa4KTwHfF6zDBsLUBEjd1f1KdeAFwYUks`

> USDT (ERC20): `0x93F4019E0aa85d8078F56B3D3176Fab5Dfa79924`

> USDT (SOL): `BorkkyPDG4aRN2op8c5SQF5NithX38U4sh7wDAWQhYyX`

> and support future Genesis LLM development.

> and support future Genesis LLM development. Details below:

<details>
❤️ Support Genesis — Help Independent Open AI Development
  
If Genesis models have improved your local AI experience, consider supporting their continued development.

Genesis is an independent AI development project focused on exploring ways to improve the reliability, efficiency, and capabilities of open-weight language models.

Over nearly six months, I've been developing and refining Genesis with the help of AI, mathematical analysis, extensive experimentation, and limited computing resources.

My goal is simple: make powerful local AI more accessible, useful, and enjoyable for everyone.

I share my work with the community because I believe meaningful AI innovation should not be limited to organisations with enormous computing budgets.

🚀 What Your Support Helps Make Possible

Your voluntary contributions can help me:

🔬 Continue researching and improving Genesis tensor calibration and processing techniques.

⚡️ Experiment with faster, more efficient local AI models.

🧠 Explore improvements in coding, reasoning, tool use, and long-context reliability.

🖥 Access better computing resources for development, testing, and validation.

📦 Release more models, quantisations, configurations, and technical updates for the community.

🌍 Keep sharing my experiments and releases openly.

Every contribution, no matter how small, helps support the time, research, experimentation, and resources behind this project.

🤝 Can't Donate? You Can Still Help!

Downloading models, sharing your results, reporting bugs, contributing benchmarks, and recommending Genesis to other developers are all valuable ways to support the project.

The models are available regardless of whether you donate. Donations are completely optional.

Thank you for experimenting with Genesis, sharing feedback, and helping independent AI development move forward.

— LuffyTheFox 🦊

Independent research. Open models. Community-powered progress.
</details>

> ⚡ **Why Genesis project exists?** During training, **ALL** models don't just learn knowledge - they also accumulate random noise in their tensors. This noise builds up and creates something I call the **Noise Gate** - a fundamental barrier that stops LLM models from learning further and makes them unstable, verbose, and prone to hallucinations. My approach reduces this noise. It repairs the signal in tensors without touching the learned knowledge and gradient using [Marchenko–Pastur distribution](https://en.wikipedia.org/wiki/Marchenko%E2%80%93Pastur_distribution) as a core criteria. The result is a model that consistent in performance, context clarity and following instructions, because it's no longer fighting its own internal chaos.

> **What is Genesis?** Genesis is post training data regeneration and calibrarion algorythm for neural networks (LLM) in GGUF format that I made with AI help during almost half a year of development. It's optimized, architecture independent, works with any model in GGUF format and based on mathematical statistics. I don't train or finetune models, I repair **purity of signal** in them instead on Google Collab Free on Tesla T4 GPU via Python based on how models learns information. On first stage I scan ssm_conv1d tensors in model, they handle long context memory. I repair balance between heads in them. On second stage, I scan blocks in model via chunks via 3 parameters and pick best one that fits to weight distribution in tensor. Best picked chunk replaces zero chunks in broken tensor without touching learned structure in model. On third stage I scan model and detect noise in tensors via custom SVD. During scanning I exclude token_embd.weight, output.weight, 1D tensors, bias and norms. Then I reduce training noise in tensors via custom SVD based on [Marchenko–Pastur law](https://en.wikipedia.org/wiki/Marchenko%E2%80%93Pastur_distribution) with preserved training data, 99% of siginal and learned gradient.

## Any questions?

> Contact: luffythefox@mail.ru, azakharchenko92@gmail.com

> My Telegram: @LuffyTheFox

Model is based on [HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive) base.

And [DJLougen/hermes-qwen3.5-35b-a3b-GGUF](https://huggingface.co/DJLougen/hermes-qwen3.5-35b-a3b-GGUF) finetune for Hermes agent.

I transferred data from finetune on Hermes dataset (around 2k blocks from two FFN expert tensors) to [HauhauCS](https://huggingface.co/HauhauCS) uncensored base.

> **[Join the Discord](https://discord.gg/SZ5vacTXYf)** for updates, roadmaps, projects, or just to chat.

Base model. [HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive)- **0/465 refusals.**

Thanks to [HauhauCS](https://huggingface.co/HauhauCS) 

Tensor repair by me. Method: **Genesis**

**Links:**
- [Original uncensored model](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive)
- [Quantization Script with Unsloth profiles support](https://pastebin.com/hXhcMJn9)

---

</details>

LLM models often have:

- **Saturated weights**: the model's activations are stuck, gradients vanish, outputs degrade.
- **Scale mismatches**: one layer's weights are 10× larger than its peers for no good reason.
- **Mean drift**: weight distributions shifted positive or negative, breaking symmetry assumptions.
- **Zero blocks**: zero blocks corrupt the signal, turning training into noise amplification.
- **Training Noise:** training noise increase randomness and ruins model output quality.

My approach fixes all of that without retraining - pure numerical surgery on the raw bytes of the file.

**Quantization script available here: https://pastebin.com/hXhcMJn9**

Feel free to do your own quants if you want.

## Recommended Settings for best perfomance on APEX quant

Chat template: [chat_template.jinja](https://huggingface.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-V7-GGUF/raw/main/chat_template.jinja) thanks to [froggeric](https://huggingface.co/froggeric) and [qweefchief](https://huggingface.co/qweefchief)

Set K Cache Quantization Type and V Cache Quantization Type to F16. 

Set Number of layers for which to force MoE weights onto CPU to 40.

Set GPU offload to maximum. Set number of active experts to 8.

**Non Thinking mode:**
- General: `temperature=0.75, top_p=0.75, top_k=20, min_p=0.05, seed=42, presence_penalty=disabled, repeat_penalty=disabled`

For Hermes Agent you can use this System Prompt: [System_Prompt_Hermes_Agent.txt](https://huggingface.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-GGUF/blob/main/System_Prompt_Hermes_Agent.txt)

For Claude Code you can use this System Prompt: [System_Prompt_Claude_Code.txt](https://huggingface.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-GGUF/blob/main/System_Prompt_Claude_Code.txt)

For JSON Mode / Structured Outputs use this System Prompt: 

`You are a helpful assistant that answers in JSON. Here's the json schema you must adhere to:\n<schema>\n{schema}\n</schema>`

And this fix: [link to discussion](https://huggingface.co/ornith-ai/Ornith-1.0-35B-GGUF/discussions/46#6a5f80e69e4b977617f0f409)

And commands from this dataset: [hermes-function-calling-v1](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1)

## Usage

**Ready to use.** Recommended quant: **Q8_K_P**

Recommended LM Studio runtime: [link to discussion](https://huggingface.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-V5-GGUF/discussions/12)

**Important:**
- Keep at least 128K context to preserve thinking capabilities
- Use `--jinja` flag with llama.cpp for proper chat template handling
- Vision support requires the `mmproj` file alongside the main GGUF

---

## Specs

- 35B total parameters, ~3B active per forward pass (MoE)
- 256 experts, 8 routed + 1 shared per token
- Hybrid architecture: Gated DeltaNet linear attention + full softmax attention (3:1 ratio)
- 40 layers, pattern: 10 × (3 × DeltaNet-MoE + 1 × Attention-MoE)
- 262K native context (extendable to 1M with YaRN)
- Natively multimodal (text, image, video)
- 248K vocabulary, 201 languages
- Base model. [HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive)

---

## Compatibility

Works with llama.cpp, LM Studio, koboldcpp, and other GGUF-compatible runtimes.