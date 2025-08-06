/*
 * LightningChartJS 2D audio analysis spectrogram example.
 */
// Import LightningChartJS
const lcjs = require('@lightningchart/lcjs')

// Extract required parts from LightningChartJS.
const { lightningChart, PalettedFill, LUT, emptyLine, AxisScrollStrategies, AxisTickStrategies, regularColorSteps, Themes } = lcjs

const AudioContext = window.AudioContext || window.webkitAudioContext
// Create a new audio context,
// for most part this context is not used for other than creating audiobuffer from audio data
const audioCtx = new AudioContext()

// General configuration for common settings
const config = {
    /**
     * The resolution of the FFT calculations
     * Higher value means higher resolution decibel domain..
     */
    fftResolution: 4096,
    /**
     * Smoothing value for FFT calculations
     */
    smoothingTimeConstant: 0.1,
    /**
     * The size of processing buffer,
     * determines how often FFT is run
     */
    processorBufferSize: 2048,
}

// Initialize LightningChart JS
const lc = lightningChart({
            resourcesBaseUrl: new URL(document.head.baseURI).origin + new URL(document.head.baseURI).pathname + 'resources/',
        })

/**
 * Fetch audio file and create audio buffer from it.
 * @param   {string}         waveformUrl    URL to the WaveForm to load
 * @returns {AudioBuffer}                   The audio file as an AudioBuffer
 */
const loadWaveForm = async (waveformUrl) => {
    // Fetch waveform
    const resp = await fetch(waveformUrl)
    // Convert fetch to array buffer
    const waveDataBuffer = await resp.arrayBuffer()
    // Convert array buffer to audio buffer
    const audioBuffer = await audioCtx.decodeAudioData(waveDataBuffer)
    return audioBuffer
}

/**
 * @typedef WaveFormData
 * @type {object}
 * @property {Uint8Array[]} channels    FFT Data for each channel
 * @property {number}       stride      Number of data points in a data block
 * @property {number}       rowCount    Number of rows of data
 * @property {number}       maxFreq     Maximum frequency of the data
 * @property {number}       duration    Audio buffer duration in seconds
 */

/**
 * Process a AudioBuffer and create FFT Data for Spectrogram from it.
 * @param   {AudioBuffer}     audioBuffer   AudioBuffer to process into FFT data.
 * @returns {WaveFormData}                  Processed data
 */
const processWaveForm = async (audioBuffer) => {
    // Create a new OfflineAudioContext with information from the pre-created audioBuffer
    // The OfflineAudioContext can be used to process a audio file as fast as possible.
    // Normal AudioContext would process the file at the speed of playback.
    const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate)
    // Create a new source, in this case we have a AudioBuffer to create it for, so we create a buffer source
    const source = offlineCtx.createBufferSource()
    // Set the buffer to the audio buffer we are using
    source.buffer = audioBuffer
    // Set source channel count to the audio buffer channel count, if this wasn't set, the source would default to 2 channels.
    source.channelCount = audioBuffer.numberOfChannels

    // We want to create spectrogram for each channel in the buffer, so we need to separate the channels to separate outputs.
    const splitter = offlineCtx.createChannelSplitter(source.channelCount)
    // Create a analyzer node for the full context
    const generalAnalyzer = offlineCtx.createAnalyser()
    generalAnalyzer.fftSize = config.fftResolution
    generalAnalyzer.smoothingTimeConstant = config.smoothingTimeConstant

    // Prepare buffers and analyzers for each channel
    const channelFFtDataBuffers = []
    const channelDbRanges = []
    const analyzers = []
    for (let i = 0; i < source.channelCount; i += 1) {
        channelFFtDataBuffers[i] = new Uint8Array((audioBuffer.length / config.processorBufferSize) * (config.fftResolution / 2))
        // Setup analyzer for this channel
        analyzers[i] = offlineCtx.createAnalyser()
        analyzers[i].smoothingTimeConstant = config.smoothingTimeConstant
        analyzers[i].fftSize = config.fftResolution
        // Connect the created analyzer to a single channel from the splitter
        splitter.connect(analyzers[i], i)
        channelDbRanges.push({
            minDecibels: analyzers[i].minDecibels,
            maxDecibels: analyzers[i].maxDecibels,
        })
    }
    // Script processor is used to process all of the audio data in fftSize sized blocks
    // Script processor is a deprecated API but the replacement APIs have really poor browser support
    offlineCtx.createScriptProcessor = offlineCtx.createScriptProcessor || offlineCtx.createJavaScriptNode
    const processor = offlineCtx.createScriptProcessor(config.processorBufferSize, 1, 1)
    let offset = 0
    processor.onaudioprocess = (ev) => {
        // Run FFT for each channel
        for (let i = 0; i < source.channelCount; i += 1) {
            const freqData = new Uint8Array(channelFFtDataBuffers[i].buffer, offset, analyzers[i].frequencyBinCount)
            analyzers[i].getByteFrequencyData(freqData)
        }
        offset += generalAnalyzer.frequencyBinCount
    }
    // Connect source buffer to correct nodes,
    // source feeds to:
    // splitter, to separate the channels
    // processor, to do the actual processing
    // generalAanalyzer, to get collective information
    source.connect(splitter)
    source.connect(processor)
    processor.connect(offlineCtx.destination)
    source.connect(generalAnalyzer)
    // Start the source, other wise start rendering would not process the source
    source.start(0)

    // Process the audio buffer
    await offlineCtx.startRendering()
    return {
        channels: channelFFtDataBuffers,
        channelDbRanges,
        stride: config.fftResolution / 2,
        tickCount: Math.ceil(audioBuffer.length / config.processorBufferSize),
        maxFreq: offlineCtx.sampleRate / 2, // max freq is always half the sample rate
        duration: audioBuffer.duration,
    }
}

/**
 * Create data matrix for heatmap from one dimensional array
 * @param {Uint8Array}  data        FFT Data
 * @param {number}      strideSize  Single data block width
 * @param {number}      tickCount    Data row count
 */
const remapDataToTwoDimensionalMatrix = (data, strideSize, tickCount) => {
    /**
     * @type {Array<number>}
     */
    const arr = Array.from(data)

    // Map the one dimensional data to two dimensional data where data goes from right to left
    // [1, 2, 3, 4, 5, 6]
    // -> strideSize = 2
    // -> rowCount = 3
    // maps to
    // [1, 4]
    // [2, 5]
    // [3, 6]
    const output = Array.from(Array(strideSize)).map(() => Array.from(Array(tickCount)))
    for (let row = 0; row < strideSize; row += 1) {
        for (let col = 0; col < tickCount; col += 1) {
            output[row][col] = arr[col * strideSize + row]
        }
    }

    return output
}

/**
 * Create a chart for a channel
 * @param {number}          channelIndex    Current channel index
 * @param {number}          rows            Data row count
 * @param {number}          columns         Data column count
 * @param {number}          maxFreq         Maximum frequency for data
 * @param {number}          duration        Duration in seconds
 * @param {number}          minDecibels     dB amount that matches value 0 in data (Uint8).
 * @param {number}          maxDecibels     dB amount that matches value 255 in data (Uint8).
 */
const createChannel = (chart, channelIndex, rows, columns, maxFreq, duration, minDecibels, maxDecibels, addToLegend) => {
    const theme = chart.getTheme()

    // Define function that maps Uint8 [0, 255] to Decibels.
    const intensityDataToDb = (intensity) => minDecibels + (intensity / 255) * (maxDecibels - minDecibels)

    // Start position of the heatmap
    const start = {
        x: 0,
        y: 0,
    }
    // End position of the heatmap
    const end = {
        x: duration,
        // Use half of the fft data range
        y: Math.ceil(maxFreq / 2),
    }
    const yAxis = chart.addAxisY({ iStack: 1 - channelIndex }).setMargins(channelIndex < 1 ? 5 : 0, channelIndex > 0 ? 5 : 0)
    // Create the series
    const lut = new LUT({
        steps: regularColorSteps(0, 255, theme.examples.spectrogramColorPalette, {
            formatLabels: (value) => `${Math.round(intensityDataToDb(value))}`,
        }),
        units: 'dB',
        interpolate: true,
    })
    const series = chart
        .addHeatmapGridSeries({
            yAxis,
            // Data columns, defines horizontal resolution
            columns: columns,
            // Use half of the fft data range
            rows: Math.ceil(rows / 2),
            dataOrder: 'rows',
            heatmapDataType: 'intensity',
        })
        .setStart(start)
        .setEnd(end)
        // Use palletted fill style, intensity values define the color for each data point based on the LUT
        .setFillStyle(
            new PalettedFill({
                lut,
            }),
        )
        .setWireframeStyle(emptyLine)

    // Set default X axis settings
    yAxis
        .setInterval({ start: start.y, end: end.y, stopAxisAfter: false })
        .setTitle(`Channel ${channelIndex + 1}`)
        .setUnits('Hz')
        .setScrollStrategy(AxisScrollStrategies.fitting)

    if (addToLegend) chart.legend.add(lut, {lutLength: 250})

    return {
        series,
        yAxis,
    }
}

/**
 * Render a spectrogram for given data set
 * @param {WaveFormData} data Data set to render
 */
const renderSpectrogram = async (data) => {
    const chart = lc
        .ChartXY({
            legend: {addEntriesAutomatically: false},
            theme: Themes[new URLSearchParams(window.location.search).get('theme') || 'darkGold'] || undefined,
        })
        .setTitle('Spectrogram chart 2 channels')
        .setCursorMode('show-nearest')
    chart
        .getDefaultAxisX()
        .setTickStrategy(AxisTickStrategies.Numeric)
        .setScrollStrategy(AxisScrollStrategies.fitting)
        .setTitle(`Duration`)
        .setUnits('s')
    chart.getDefaultAxisY().dispose()
    // Create channels and set data for each channel
    for (let i = 0; i < data.channels.length; i += 1) {
        // Create a chart for the channel
        const ch = createChannel(
            chart,
            i,
            data.stride,
            data.tickCount,
            data.maxFreq,
            data.duration,
            data.channelDbRanges[i].minDecibels,
            data.channelDbRanges[i].maxDecibels,
            i === 0,
        )
        // Setup the data for the chart
        const remappedData = remapDataToTwoDimensionalMatrix(data.channels[i], data.stride, data.tickCount)
            // Slice only first half of data (rest are 0s).
            .slice(0, data.stride / 2)

        // Set the heatmap data
        ch.series.invalidateIntensityValues({
            iRow: 0,
            iColumn: 0,
            values: remappedData,
        })
    }
}

;(async () => {
    // Remove loading spinner
    document.querySelectorAll('.loading').forEach((item) => {
        item.parentElement.removeChild(item)
    })
    const run = async () => {
        // Load waveform from url
        const waveform = await loadWaveForm(
            new URL(document.head.baseURI).origin +
                new URL(document.head.baseURI).pathname +
                'examples/assets/0802/Truck_driving_by-Jason_Baker-2112866529_edit.wav',
        )
        // Process the loaded wave form to prepare it for being added to the chart
        const processed = await processWaveForm(waveform)
        // Create a dashboard from the processed waveform data
        renderSpectrogram(processed)
    }
    // Check if audio context was started
    if (audioCtx.state === 'suspended') {
        // Show a large play button
        const resumeElement = document.createElement('div')
        resumeElement.style.position = 'absolute'
        resumeElement.style.top = '0'
        resumeElement.style.left = '0'
        resumeElement.style.right = '0'
        resumeElement.style.bottom = '0'

        const resumeImg = document.createElement('img')
        resumeImg.crossOrigin = ''
        resumeImg.src =
            new URL(document.head.baseURI).origin +
            new URL(document.head.baseURI).pathname +
            'examples/assets/0802/play_circle_outline-24px.svg'
        resumeImg.style.width = '100%'
        resumeImg.style.height = '100%'

        resumeElement.onclick = () => {
            audioCtx.resume()
        }
        resumeElement.appendChild(resumeImg)

        const innerElement = document.querySelector('.chart')
        let target
        if (!innerElement) {
            target = document.createElement('div')
            target.classList.add('inner')
            document.body.appendChild(target)
        }
        const targetElement = innerElement || target
        targetElement.appendChild(resumeElement)

        // Attach a listener to the audio context to remove the play button as soon as the context is running
        audioCtx.onstatechange = () => {
            if (audioCtx.state === 'running') {
                run()
                audioCtx.onstatechange = void 0
                targetElement.removeChild(resumeElement)
            }
        }
    } else {
        // Audio context is running so run the example
        run()
    }
})()
