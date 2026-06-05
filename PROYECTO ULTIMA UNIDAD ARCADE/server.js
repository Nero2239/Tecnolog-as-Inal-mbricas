const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sql = require('mssql');

const app = express();

// Middlewares para permitir comunicación con Python, la ESP32 y procesamiento de JSON
app.use(cors());
app.use(bodyParser.json());

// CONFIGURACIÓN DE TU DOCKER LOCAL
const dbConfig = {
    user: 'sa',
    password: 'C0NTR453N1!4',//'JasonMakana@2005', // Tu contraseña de Docker
    server: '127.0.0.1',//'192.168.0.103',          // Tu propia máquina local
    database: 'arcade_db',        // La base de datos del proyecto
    port: 1433,                   // Puerto nativo de SQL Server mapeado en Docker
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

// Variable global en memoria para mantener el estado del "buzón" del último jugador escaneado
let ultimoEscaneo = {
    id_rfid: "--------",
    usr: "Esperando...",
    score: 0,
    name_disp: "Ninguno"
};

// =========================================================================
// 1. RUTA POST: RECIBE EL SCORE AL MORIR Y LO ACUMULA AL TOTAL DEL JUGADOR
// =========================================================================
app.post('/api/puntuaciones', async (req, res) => {
    const { name_disp, usr, score, id_rfid } = req.body;
    
    console.log(`\n[API POST] Procesando puntos -> RFID: ${id_rfid} | Puntos a reportar: ${score}`);

    try {
        let pool = await sql.connect(dbConfig);
        
        // Buscar si el usuario ya tiene un registro previo en la base de datos con esa tarjeta
        let resultado = await pool.request()
            .input('id_rfid', sql.VarChar, id_rfid)
            .query(`SELECT SCORE FROM puntuaciones WHERE ID_RFID = @id_rfid`);

        let nuevoTotal = score;

        if (resultado.recordset.length > 0) {
            // EL JUGADOR YA EXISTE: Sumamos sus nuevos puntos al acumulado histórico
            let puntosActuales = resultado.recordset[0].SCORE;
            nuevoTotal = puntosActuales + score;

            await pool.request()
                .input('nuevo_score', sql.Int, nuevoTotal)
                .input('name_disp', sql.VarChar, name_disp)
                .input('usr', sql.VarChar, usr)
                .input('id_rfid', sql.VarChar, id_rfid)
                .query(`UPDATE puntuaciones 
                        SET SCORE = @nuevo_score, NAME_DISP = @name_disp, USR = @usr, LAST_GAME = GETDATE()
                        WHERE ID_RFID = @id_rfid`);

            console.log(`[SQL] ¡Puntos acumulados con éxito! Total anterior: ${puntosActuales} | Nuevo Total Global: ${nuevoTotal}`);

        } else {
            // JUGADOR NUEVO: Creamos su primera fila en la tabla con sus puntos iniciales
            await pool.request()
                .input('name_disp', sql.VarChar, name_disp)
                .input('usr', sql.VarChar, usr)
                .input('score', sql.Int, score)
                .input('id_rfid', sql.VarChar, id_rfid)
                .query(`INSERT INTO puntuaciones (NAME_DISP, USR, SCORE, ID_RFID) 
                        VALUES (@name_disp, @usr, @score, @id_rfid)`);
            
            console.log("[SQL] ¡Jugador nuevo registrado con éxito en el monedero global!");
        }

        // --- CORRECCIÓN CRUCIAL DE ARRANQUE AUTOMÁTICO ---
        // Al terminar la partida, dejamos el buzón de login vacío (en líneas de guiones).
        // De esta forma, Python guardará el score pero NO se reiniciará solo; se verá 
        // forzado a quedarse en la pantalla de espera hasta que la ESP32 mande un nuevo GET.
        ultimoEscaneo = {
            id_rfid: "--------",
            usr: "Esperando...",
            score: 0,
            name_disp: "Ninguno"
        };

        res.status(200).json({ 
            status: "success", 
            action: resultado.recordset.length > 0 ? "update" : "insert", 
            total_score: nuevoTotal 
        });

    } catch (err) {
        console.error("[ERROR SQL POST]", err.message);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// =========================================================================
// 2. RUTA GET: CONSULTA EL SALDO ACUMULADO DEL JUGADOR AL ESCANEAR SU TARJETA
// =========================================================================
app.get('/api/puntuaciones/:rfid', async (req, res) => {
    const rfidConsultado = req.params.rfid;
    console.log(`\n[API GET] Consultando puntos del RFID: ${rfidConsultado}`);

    try {
        let pool = await sql.connect(dbConfig);
        let resultado = await pool.request()
            .input('id_rfid', sql.VarChar, rfidConsultado)
            .query(`SELECT SCORE, USR FROM puntuaciones WHERE ID_RFID = @id_rfid`);

        if (resultado.recordset.length > 0) {
            console.log(`[SQL] Tarjeta encontrada. Saldo actual: ${resultado.recordset[0].SCORE} pts.`);
            
            // Llenamos el buzón para que Python sepa que un usuario acaba de loggearse
            ultimoEscaneo = {
                id_rfid: rfidConsultado,
                usr: resultado.recordset[0].USR,
                score: resultado.recordset[0].SCORE,
                name_disp: "Arcade_ESP32_WiFi"
            };

            res.status(200).json({ 
                existe: true, 
                score: resultado.recordset[0].SCORE, 
                usr: resultado.recordset[0].USR 
            });
        } else {
            console.log(`[SQL] Tarjeta nueva. Iniciando cuenta en 0 pts.`);
            
            // Llenamos el buzón con datos en 0 para usuario nuevo
            ultimoEscaneo = {
                id_rfid: rfidConsultado,
                usr: `User_${rfidConsultado.substring(0,4)}`,
                score: 0,
                name_disp: "Arcade_ESP32_WiFi"
            };

            res.status(200).json({ 
                existe: false, 
                score: 0,
                usr: `User_${rfidConsultado.substring(0,4)}`
            });
        }
    } catch (err) {
        console.error("[ERROR SQL GET]", err.message);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 3. RUTA GET EXTRA: ENTREGA EL ÚLTIMO MOVIMIENTO AL JUEGO EN PYTHON Y LO LIMPIA
// =========================================================================
app.get('/api/ultimo-movimiento', (req, res) => {
    // Enviamos el estado actual del buzón a Python
    res.status(200).json(ultimoEscaneo);

    // Vaciamos el buzón inmediatamente después de ser leído para que Python no lea doble
    ultimoEscaneo = {
        id_rfid: "--------",
        usr: "Esperando...",
        score: 0,
        name_disp: "Ninguno"
    };
});

// =========================================================================
// 4. ARRANQUE DEL SERVIDOR PUENTE IoT
// =========================================================================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`====================================================================`);
    console.log(`  Servidor Monedero Arcade Centralizado corriendo en puerto ${PORT}`);
    console.log(`  Listo para acumular puntos por RFID y sincronizar con tus compañeros`);
    console.log(`====================================================================`);
});