(function () {
  const { useEffect, useMemo, useState } = React;
  const baseUrl = () => window.location.hostname === "localhost" ? "http://localhost:3000" : window.location.origin;
  const headers = (extra={}) => {
    const token = sessionStorage.getItem("granosys_access_token");
    return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
  };
  async function request(path, options={}) {
    const response = await fetch(`${baseUrl()}${path}`, { cache:"no-store", ...options, headers:headers(options.headers || {}) });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error:text }; }
    if (!response.ok) throw new Error(body?.error || `Error ${response.status}`);
    return body;
  }
  const get = path => request(path);
  const post = (path, data) => request(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data) });
  const patch = (path, data) => request(path, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data) });
  const money = value => Number(value || 0).toLocaleString("es-AR", { minimumFractionDigits:2, maximumFractionDigits:2 });
  const date = value => value ? String(value).slice(0,10).split("-").reverse().join("/") : "—";

  const Button = ({children,onClick,secondary=false,danger=false,disabled=false,type="button"}) => (
    <button type={type} disabled={disabled} onClick={onClick} style={{
      padding:"8px 13px",borderRadius:6,fontSize:12,fontWeight:700,
      background:danger?"rgba(231,76,60,.12)":secondary?"#2a2d3e":"#f5a623",
      color:danger?"#e74c3c":secondary?"#e8eaf0":"#111",border:danger?"1px solid rgba(231,76,60,.3)":"none",
      opacity:disabled ? .55 : 1,cursor:disabled?"not-allowed":"pointer"
    }}>{children}</button>
  );
  const Field = ({label,children}) => <label className="form-field"><span className="form-label">{label}</span>{children}</label>;
  const Modal = ({title,onClose,children,footer,width=980}) => (
    <div className="modal-overlay"><div className="modal" style={{maxWidth:width}}>
      <div className="modal-header"><strong>{title}</strong><button onClick={onClose} style={{background:"none",color:"#8890a8",fontSize:24}}>×</button></div>
      <div className="modal-body">{children}</div>
      {footer&&<div className="modal-footer">{footer}</div>}
    </div></div>
  );
  const Badge = ({children,color="#f5a623"}) => <span className="badge" style={{background:`${color}20`,color,border:`1px solid ${color}55`}}>{children}</span>;

  const instrumentoVacio = () => ({ medio_pago:"TRANSFERENCIA", importe:"", id_cuenta_bancaria:"", referencia:"", cheque:{ tipo:"PROPIO", numero:"", banco:"", librador:"", cuit_librador:"", fecha_emision:new Date().toISOString().slice(0,10), fecha_pago:"", observaciones:"" } });
  const ordenVacia = (clase,modulo="FORMAL") => ({
    clase_pago:clase, modalidad_origen:clase==="PAGO_PROPIO"?"FORMAL":modulo==="INFORMAL"?"INFORMAL":"FORMAL", id_contraparte:"", fecha:new Date().toISOString().slice(0,10),
    fecha_pago:new Date().toISOString().slice(0,10), concepto:"", importe_bruto:"", moneda:"PESOS",
    entregado_por:"", recibido_por:"", instrumentos:[instrumentoVacio()], conceptos_fiscales:[], aplicaciones:[]
  });

  function InstrumentoForm({item,index,cuentas,onChange,onRemove}) {
    const esCheque = ["CHEQUE_PROPIO","CHEQUE_TERCEROS","ECHEQ"].includes(item.medio_pago);
    const update = changes => onChange(index,{...item,...changes});
    const updateCheque = changes => update({cheque:{...item.cheque,...changes}});
    return <div style={{padding:14,border:"1px solid #2a2d3e",borderRadius:8,marginBottom:10,background:"#11141c"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><strong>Instrumento {index+1}</strong>{onRemove&&<Button danger onClick={()=>onRemove(index)}>Quitar</Button>}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:"0 12px"}}>
        <Field label="Medio de pago"><select value={item.medio_pago} onChange={e=>{
          const medio=e.target.value; const tipo=medio==="CHEQUE_PROPIO"?"PROPIO":medio==="ECHEQ"?"ECHEQ":"TERCERO";
          update({medio_pago:medio,cheque:{...item.cheque,tipo}});
        }}><option value="TRANSFERENCIA">Transferencia</option><option value="CHEQUE_PROPIO">Cheque propio</option><option value="CHEQUE_TERCEROS">Cheque de terceros</option><option value="ECHEQ">eCheq</option><option value="EFECTIVO">Efectivo</option><option value="OTRO">Otro</option></select></Field>
        <Field label="Importe"><input type="number" step="0.01" value={item.importe} onChange={e=>update({importe:e.target.value})}/></Field>
        {(item.medio_pago==="TRANSFERENCIA"||item.medio_pago==="CHEQUE_PROPIO")&&<Field label="Cuenta bancaria"><select value={item.id_cuenta_bancaria||""} onChange={e=>update({id_cuenta_bancaria:e.target.value})}><option value="">Seleccionar...</option>{cuentas.map(c=><option key={c.id} value={c.id}>{c.banco} · {c.nombre}</option>)}</select></Field>}
        <Field label="Referencia"><input value={item.referencia} onChange={e=>update({referencia:e.target.value})} placeholder="Transferencia / comprobante"/></Field>
      </div>
      {esCheque&&<>
        <div className="alert-info" style={{margin:"4px 0 12px"}}>✓ El cheque se registra como <strong>cruzado</strong> y conserva toda su trazabilidad.</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:"0 12px"}}>
          <Field label="Tipo"><input readOnly value={item.cheque.tipo==="PROPIO"?"Cheque propio":item.cheque.tipo==="ECHEQ"?"eCheq":"Cheque de terceros"}/></Field>
          <Field label="Número"><input value={item.cheque.numero} onChange={e=>updateCheque({numero:e.target.value})}/></Field>
          <Field label="Banco"><input value={item.cheque.banco} onChange={e=>updateCheque({banco:e.target.value})}/></Field>
          <Field label="Librador"><input value={item.cheque.librador} onChange={e=>updateCheque({librador:e.target.value})}/></Field>
          <Field label="CUIT librador"><input value={item.cheque.cuit_librador} onChange={e=>updateCheque({cuit_librador:e.target.value})}/></Field>
          <Field label="Fecha emisión"><input type="date" value={item.cheque.fecha_emision} onChange={e=>updateCheque({fecha_emision:e.target.value})}/></Field>
          <Field label="Fecha de pago"><input type="date" value={item.cheque.fecha_pago} onChange={e=>updateCheque({fecha_pago:e.target.value})}/></Field>
          <Field label="Observaciones"><input value={item.cheque.observaciones} onChange={e=>updateCheque({observaciones:e.target.value})}/></Field>
        </div>
      </>}
    </div>;
  }

  function OrdenDetalle({orden,onClose}) {
    return <Modal title={`${orden.clase_pago==="PAGO_PROPIO"?"Pago Propio":"Orden de Pago"} ${orden.numero}`} onClose={onClose} footer={<Button secondary onClick={onClose}>Cerrar</Button>}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:18}}>
        {[["Beneficiario",orden.contraparte],["Fecha",date(orden.fecha)],["Bruto",`$ ${money(orden.importe_bruto)}`],["Retenciones",`$ ${money(orden.total_retenciones)}`],["Neto pagado",`$ ${money(orden.importe_total)}`],["Estado",orden.estado]].map(([l,v])=><div key={l} style={{padding:12,background:"#11141c",borderRadius:7}}><div className="form-label">{l}</div><strong>{v}</strong></div>)}
      </div>
      <div className="alert-info" style={{marginBottom:16}}>{orden.concepto}</div>
      <h3 style={{fontSize:14,marginBottom:8}}>Instrumentos de pago</h3>
      <div style={{overflowX:"auto",marginBottom:18}}><table><thead><tr><th>Medio</th><th>Importe</th><th>Cuenta / Banco</th><th>Cheque</th><th>Vencimiento</th><th>Estado</th></tr></thead><tbody>{(orden.instrumentos||[]).map(i=><tr key={i.id}><td>{i.cheque_tipo==="PROPIO"?"Cheque propio":i.cheque_tipo==="TERCERO"?"Cheque de terceros":i.cheque_tipo==="ECHEQ"?"eCheq":i.medio_pago}</td><td className="mono">$ {money(i.importe)}</td><td>{i.cuenta_bancaria||i.cheque_banco||"—"}</td><td>{i.cheque_numero?<><span className="mono">{i.cheque_numero}</span> {i.cruzado&&<Badge color="#27ae60">Cruzado</Badge>}</>:"—"}</td><td>{date(i.cheque_fecha_pago)}</td><td>{i.cheque_estado||i.estado}</td></tr>)}</tbody></table></div>
      {!!orden.conceptos_fiscales?.length&&<><h3 style={{fontSize:14,marginBottom:8}}>Impuestos y retenciones</h3><div style={{overflowX:"auto",marginBottom:18}}><table><thead><tr><th>Concepto</th><th>Naturaleza</th><th>Base</th><th>Alícuota</th><th>Importe</th></tr></thead><tbody>{orden.conceptos_fiscales.map(c=><tr key={c.id}><td>{c.nombre}</td><td>{c.naturaleza}</td><td>$ {money(c.base_imponible)}</td><td>{c.alicuota==null?"—":`${c.alicuota}%`}</td><td>$ {money(c.importe)}</td></tr>)}</tbody></table></div></>}
      {!!orden.aplicaciones?.length&&<><h3 style={{fontSize:14,marginBottom:8}}>Liquidaciones imputadas</h3><div style={{overflowX:"auto",marginBottom:18}}><table><thead><tr><th>Liquidación</th><th>Importe aplicado</th></tr></thead><tbody>{orden.aplicaciones.map(a=><tr key={a.id}><td>{a.nro_liquidacion}</td><td>$ {money(a.importe)}</td></tr>)}</tbody></table></div></>}
      <h3 style={{fontSize:14,marginBottom:8}}>Trazabilidad cruzada</h3>
      <div style={{overflowX:"auto"}}><table><thead><tr><th>Fecha</th><th>Evento</th><th>De</th><th>A</th><th>Entrega</th><th>Recibe</th></tr></thead><tbody>{(orden.trazabilidad||[]).map(t=><tr key={t.id}><td>{date(t.fecha)}</td><td>{t.evento.replaceAll("_"," ")}</td><td>{t.modalidad_origen||"—"}</td><td>{t.contraparte_destino||t.modalidad_destino||"—"}</td><td>{t.entregado_por||"—"}</td><td>{t.recibido_por||"—"}</td></tr>)}</tbody></table></div>
    </Modal>;
  }

  window.TesoreriaOrdenDetalle = OrdenDetalle;

  window.TesoreriaScreen = function TesoreriaScreen({modulo="FORMAL"}) {
    const [tab,setTab]=useState(modulo==="INFORMAL"?"propio":"proveedores");
    const [resumen,setResumen]=useState({});
    const [ordenes,setOrdenes]=useState([]);
    const [cheques,setCheques]=useState([]);
    const [cuentas,setCuentas]=useState([]);
    const [contrapartes,setContrapartes]=useState([]);
    const [conceptos,setConceptos]=useState([]);
    const [liquidaciones,setLiquidaciones]=useState([]);
    const [cartera,setCartera]=useState([]);
    const [loading,setLoading]=useState(false);
    const [error,setError]=useState("");
    const [showOrden,setShowOrden]=useState(false);
    const [ordenForm,setOrdenForm]=useState(ordenVacia("PAGO_PROVEEDOR",modulo));
    const [detalle,setDetalle]=useState(null);
    const [asignar,setAsignar]=useState(null);
    const [asignacion,setAsignacion]=useState({id_contraparte_destino:"",fecha:new Date().toISOString().slice(0,10),importe:"",concepto:"",entregado_por:"",recibido_por:""});
    const [showCuenta,setShowCuenta]=useState(false);
    const [cuentaForm,setCuentaForm]=useState({nombre:"",banco:"",tipo_cuenta:"CUENTA_CORRIENTE",numero_cuenta:"",cbu:"",alias:"",moneda:"PESOS"});
    const [showConcepto,setShowConcepto]=useState(false);
    const [conceptoForm,setConceptoForm]=useState({codigo:"",nombre:"",categoria:"RETENCION_IVA",naturaleza:"RETENCION",alicuota_default:""});

    const cargar=async()=>{
      setLoading(true);setError("");
      try {
        const [r,o,ch,cb,cp,cf,lq,car]=await Promise.all([
          get("/api/tesoreria/resumen"),get("/api/tesoreria/ordenes-pago?limite=500"),get("/api/tesoreria/cheques"),
          get("/api/tesoreria/cuentas-bancarias"),get("/api/contrapartes"),get("/api/tesoreria/conceptos-fiscales"),
          get(`/api/liquidaciones?modalidad=${modulo==="CONSOLIDADO"?"FORMAL":modulo}`),get("/api/tesoreria/pago-propio/cartera")
        ]);
        setResumen(r||{});setOrdenes(o||[]);setCheques(ch||[]);setCuentas(cb||[]);setContrapartes(cp||[]);setConceptos(cf||[]);setLiquidaciones(lq||[]);setCartera(car||[]);
      } catch(e){setError(e.message)} finally{setLoading(false)}
    };
    useEffect(()=>{cargar()},[modulo]);
    const abrirOrden=clase=>{setError("");setOrdenForm(ordenVacia(clase,modulo));setShowOrden(true)};
    const ordenesFiltradas=useMemo(()=>ordenes.filter(o=>tab==="proveedores"?o.clase_pago==="PAGO_PROVEEDOR":o.clase_pago==="PAGO_PROPIO"),[ordenes,tab]);
    const totalAdiciones=ordenForm.conceptos_fiscales.reduce((s,x)=>s+(x.naturaleza==="ADICION"?Number(x.importe||0):0),0);
    const totalRetenciones=ordenForm.conceptos_fiscales.reduce((s,x)=>s+(x.naturaleza==="RETENCION"?Number(x.importe||0):0),0);
    const neto=Math.max(0,Number(ordenForm.importe_bruto||0)+totalAdiciones-totalRetenciones);
    const guardarOrden=async()=>{
      setLoading(true);setError("");
      try {
        const payload={...ordenForm,id_contraparte:Number(ordenForm.id_contraparte),importe_bruto:Number(ordenForm.importe_bruto),
          instrumentos:ordenForm.instrumentos.map(i=>({...i,importe:Number(i.importe),id_cuenta_bancaria:i.id_cuenta_bancaria?Number(i.id_cuenta_bancaria):null})),
          conceptos_fiscales:ordenForm.conceptos_fiscales.map(x=>({...x,id_concepto_fiscal:Number(x.id_concepto_fiscal),importe:Number(x.importe),base_imponible:x.base_imponible?Number(x.base_imponible):null,alicuota:x.alicuota?Number(x.alicuota):null})),
          aplicaciones:ordenForm.aplicaciones.filter(x=>x.id_liquidacion&&x.importe).map(x=>({id_liquidacion:Number(x.id_liquidacion),importe:Number(x.importe)}))};
        const created=await post("/api/tesoreria/ordenes-pago",payload);setShowOrden(false);await cargar();setDetalle(await get(`/api/tesoreria/ordenes-pago/${created.id}`));
      } catch(e){setError(e.message)} finally{setLoading(false)}
    };
    const verOrden=async id=>{try{setDetalle(await get(`/api/tesoreria/ordenes-pago/${id}`))}catch(e){setError(e.message)}};
    const cambiarCheque=async(ch,estado)=>{try{
      let entregado_por="",recibido_por="";if(["TRANSFERIDO","DEVUELTO","ENTREGADO","ENDOSADO"].includes(estado)){entregado_por=prompt("¿Quién entrega el cheque?")||"";recibido_por=prompt("¿Quién recibe el cheque?")||"";if(!entregado_por||!recibido_por)return;}
      await patch(`/api/tesoreria/cheques/${ch.id}/estado`,{estado,entregado_por,recibido_por});await cargar();
    }catch(e){setError(e.message)}};
    const guardarAsignacion=async()=>{try{await post(`/api/tesoreria/pago-propio/${asignar.id_orden_pago}/asignaciones`,{...asignacion,id_movimiento_tesoreria:Number(asignar.id_movimiento_tesoreria),id_contraparte_destino:Number(asignacion.id_contraparte_destino),importe:Number(asignacion.importe)});setAsignar(null);await cargar();}catch(e){setError(e.message)}};
    const guardarCuenta=async()=>{try{await post("/api/tesoreria/cuentas-bancarias",cuentaForm);setShowCuenta(false);await cargar();}catch(e){setError(e.message)}};
    const guardarConcepto=async()=>{try{await post("/api/tesoreria/conceptos-fiscales",{...conceptoForm,alicuota_default:conceptoForm.alicuota_default===""?null:Number(conceptoForm.alicuota_default)});setShowConcepto(false);await cargar();}catch(e){setError(e.message)}};
    const exportar=(rows,nombre)=>{if(!rows.length)return;const ws=XLSX.utils.json_to_sheet(rows);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Tesoreria");XLSX.writeFile(wb,`${nombre}_${new Date().toISOString().slice(0,10)}.xlsx`)};

    return <div className="fade-in">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:18}}><div><h2 style={{fontSize:20}}>Tesorería Central</h2><div style={{fontSize:12,color:"#8890a8"}}>Órdenes de pago, instrumentos, impuestos y trazabilidad Formal / Informal.</div></div><div style={{display:"flex",gap:8}}><Button secondary onClick={cargar}>{loading?"Actualizando...":"↻ Actualizar"}</Button>{tab==="proveedores"&&<Button onClick={()=>abrirOrden("PAGO_PROVEEDOR")}>+ Pago a Proveedores</Button>}{tab==="propio"&&modulo!=="INFORMAL"&&<Button onClick={()=>abrirOrden("PAGO_PROPIO")}>+ Pago Propio</Button>}</div></div>
      {error&&<div className="alert-danger" style={{marginBottom:14}}>{error}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
        {[["Pagos a proveedores",resumen.pagos_proveedores,"#3498db"],["Pago Propio",resumen.pagos_propios,"#f5a623"],["Disponible Pago Propio",resumen.pago_propio_disponible,"#27ae60"],["Cheques en cartera",resumen.importe_cartera,"#9b59b6"]].map(([l,v,c])=><div className="stat-card" key={l}><div className="stat-top" style={{background:c}}/><div className="form-label">{l}</div><div className="mono" style={{fontSize:20,fontWeight:700,color:c}}>$ {money(v)}</div></div>)}
      </div>
      <div className="tab-bar" style={{marginBottom:16}}>{[["proveedores","Pago a Proveedores"],["propio","Pago Propio"],["cheques","Cheques"],["cuentas","Cuentas"],["impuestos","Impuestos y Retenciones"]].map(([id,label])=><button key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{label}</button>)}</div>
      {(tab==="proveedores"||tab==="propio")&&<>
        {tab==="propio"&&<div className="alert-info" style={{marginBottom:14}}><strong>Pago Propio:</strong> cartera operativa central. No duplica Tesorería cuando se imputa en Informal. Cada cheque físico se entrega completo a un solo proveedor.</div>}
        <div className="card" style={{marginBottom:16}}><div className="card-header"><strong>{tab==="proveedores"?"Órdenes de Pago a Proveedores":"Órdenes de Pago Propio"}</strong><Button secondary onClick={()=>exportar(ordenesFiltradas,"ordenes_pago")}>Exportar Excel</Button></div><div style={{overflowX:"auto"}}><table><thead><tr><th>Número</th><th>Fecha</th><th>Beneficiario / receptor</th><th>Concepto</th><th>Neto</th><th>Instrumentos</th><th>Estado</th><th></th></tr></thead><tbody>{ordenesFiltradas.map(o=><tr key={o.id}><td className="mono" style={{color:"#f5a623"}}>{o.numero}</td><td>{date(o.fecha)}</td><td>{o.contraparte}</td><td>{o.concepto}</td><td className="mono">$ {money(o.importe_total)}</td><td>{o.instrumentos}</td><td><Badge color="#27ae60">{o.estado}</Badge></td><td><Button secondary onClick={()=>verOrden(o.id)}>Ver orden</Button></td></tr>)}{!ordenesFiltradas.length&&<tr><td colSpan="8" style={{textAlign:"center",padding:28,color:"#8890a8"}}>No hay órdenes registradas.</td></tr>}</tbody></table></div></div>
        {tab==="propio"&&<div className="card"><div className="card-header"><strong>Subcartera disponible instrumento por instrumento</strong></div><div style={{overflowX:"auto"}}><table><thead><tr><th>Orden</th><th>Instrumento</th><th>Banco / número</th><th>Vencimiento</th><th>Importe</th><th>Disponible</th><th></th></tr></thead><tbody>{cartera.map(i=><tr key={i.id_movimiento_tesoreria}><td className="mono">{i.orden_numero}</td><td>{i.cheque_tipo==="PROPIO"?"Cheque propio":i.cheque_tipo==="TERCERO"?"Cheque tercero":i.cheque_tipo==="ECHEQ"?"eCheq":i.medio_pago}</td><td>{i.cheque_banco?`${i.cheque_banco} · ${i.cheque_numero}`:"—"} {i.cruzado&&<Badge color="#27ae60">Cruzado</Badge>}</td><td>{date(i.fecha_pago)}</td><td>$ {money(i.importe)}</td><td style={{color:"#27ae60",fontWeight:700}}>$ {money(i.disponible)}</td><td><Button onClick={()=>{setError("");setAsignar(i);setAsignacion({id_contraparte_destino:"",fecha:new Date().toISOString().slice(0,10),importe:i.cheque_id?i.disponible:"",concepto:"",entregado_por:"",recibido_por:""})}}>Imputar</Button></td></tr>)}{!cartera.length&&<tr><td colSpan="7" style={{textAlign:"center",padding:28,color:"#8890a8"}}>No hay instrumentos pendientes de imputar.</td></tr>}</tbody></table></div></div>}
      </>}
      {tab==="cheques"&&<div className="card"><div className="card-header"><strong>Cheques propios, de terceros y eCheq</strong><Button secondary onClick={()=>exportar(cheques,"cheques")}>Exportar Excel</Button></div><div style={{overflowX:"auto"}}><table><thead><tr><th>Tipo</th><th>Banco</th><th>Número</th><th>Librador</th><th>Vencimiento</th><th>Importe</th><th>Cruzado</th><th>Estado</th></tr></thead><tbody>{cheques.map(ch=><tr key={ch.id}><td>{ch.tipo==="PROPIO"?"Cheque propio":ch.tipo==="TERCERO"?"Cheque de terceros":"eCheq"}</td><td>{ch.banco}</td><td className="mono">{ch.numero}</td><td>{ch.librador||"—"}</td><td>{date(ch.fecha_pago)}</td><td>$ {money(ch.importe)}</td><td><Badge color="#27ae60">Sí</Badge></td><td><select style={{minWidth:135}} value={ch.estado} onChange={e=>cambiarCheque(ch,e.target.value)}>{["EMITIDO","EN_CARTERA","TRANSFERIDO","DEVUELTO","ENDOSADO","ENTREGADO","DEPOSITADO","ACREDITADO","RECHAZADO","ANULADO"].map(x=><option key={x}>{x}</option>)}</select></td></tr>)}</tbody></table></div></div>}
      {tab==="cuentas"&&<div className="card"><div className="card-header"><strong>Cuentas bancarias centrales</strong><Button onClick={()=>{setError("");setShowCuenta(true)}}>+ Cuenta bancaria</Button></div><div style={{overflowX:"auto"}}><table><thead><tr><th>Banco</th><th>Nombre</th><th>Tipo</th><th>Número</th><th>CBU</th><th>Alias</th><th>Moneda</th></tr></thead><tbody>{cuentas.map(c=><tr key={c.id}><td>{c.banco}</td><td>{c.nombre}</td><td>{c.tipo_cuenta||"—"}</td><td className="mono">{c.numero_cuenta||"—"}</td><td className="mono">{c.cbu||"—"}</td><td>{c.alias||"—"}</td><td>{c.moneda}</td></tr>)}</tbody></table></div></div>}
      {tab==="impuestos"&&<div className="card"><div className="card-header"><div><strong>Impuestos y retenciones centrales</strong><div style={{fontSize:11,color:"#8890a8"}}>IVA, Ganancias y retenciones parametrizables para Formal e Informal.</div></div><Button onClick={()=>{setError("");setShowConcepto(true)}}>+ Concepto fiscal</Button></div><div style={{overflowX:"auto"}}><table><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Naturaleza</th><th>Alícuota predeterminada</th><th>Vigencia</th></tr></thead><tbody>{conceptos.map(c=><tr key={c.id}><td className="mono">{c.codigo}</td><td>{c.nombre}</td><td>{c.categoria}</td><td>{c.naturaleza}</td><td>{c.alicuota_default==null?"A definir":`${c.alicuota_default}%`}</td><td>{c.vigente_desde?`${date(c.vigente_desde)} a ${date(c.vigente_hasta)}`:"Sin vigencia fija"}</td></tr>)}</tbody></table></div></div>}

      {showOrden&&<Modal title={ordenForm.clase_pago==="PAGO_PROPIO"?"Nuevo Pago Propio":"Nueva Orden de Pago a Proveedores"} onClose={()=>setShowOrden(false)} footer={<><Button secondary onClick={()=>setShowOrden(false)}>Cancelar</Button><Button disabled={loading} onClick={guardarOrden}>Emitir y pagar orden</Button></>}>
        {error&&<div className="alert-danger" style={{marginBottom:14}}>{error}</div>}
        {ordenForm.clase_pago==="PAGO_PROPIO"&&<div className="alert-info" style={{marginBottom:14}}>Todo recurso enviado al circuito Informal queda caratulado <strong>Pago Propio</strong>. Seleccioná como receptor a Inversiones Siembra cuando corresponda.</div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))",gap:"0 14px"}}><Field label="Beneficiario / receptor"><select value={ordenForm.id_contraparte} onChange={e=>setOrdenForm({...ordenForm,id_contraparte:e.target.value})}><option value="">Seleccionar...</option>{contrapartes.map(c=><option key={c.id} value={c.id}>{c.razon_social} {c.cuit?`· ${c.cuit}`:""}</option>)}</select></Field><Field label="Fecha de orden"><input type="date" value={ordenForm.fecha} onChange={e=>setOrdenForm({...ordenForm,fecha:e.target.value})}/></Field><Field label="Fecha de pago"><input type="date" value={ordenForm.fecha_pago} onChange={e=>setOrdenForm({...ordenForm,fecha_pago:e.target.value})}/></Field><Field label="Importe bruto"><input type="number" step="0.01" value={ordenForm.importe_bruto} onChange={e=>setOrdenForm({...ordenForm,importe_bruto:e.target.value})}/></Field><Field label="Concepto"><input value={ordenForm.concepto} onChange={e=>setOrdenForm({...ordenForm,concepto:e.target.value})}/></Field><Field label="Moneda"><select value={ordenForm.moneda} onChange={e=>setOrdenForm({...ordenForm,moneda:e.target.value})}><option>PESOS</option><option>DOLARES</option></select></Field><Field label="Entrega"><input value={ordenForm.entregado_por} onChange={e=>setOrdenForm({...ordenForm,entregado_por:e.target.value})} placeholder="Quién entrega"/></Field><Field label="Recibe"><input value={ordenForm.recibido_por} onChange={e=>setOrdenForm({...ordenForm,recibido_por:e.target.value})} placeholder="Quién recibe"/></Field></div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"12px 0 8px"}}><h3 style={{fontSize:14}}>Impuestos y retenciones</h3><Button secondary onClick={()=>setOrdenForm({...ordenForm,conceptos_fiscales:[...ordenForm.conceptos_fiscales,{id_concepto_fiscal:"",naturaleza:"RETENCION",base_imponible:ordenForm.importe_bruto,alicuota:"",importe:""}]})}>+ Concepto</Button></div>
        {ordenForm.conceptos_fiscales.map((x,idx)=><div key={idx} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",gap:8,alignItems:"end",marginBottom:8}}><Field label="Concepto"><select value={x.id_concepto_fiscal} onChange={e=>{const c=conceptos.find(i=>String(i.id)===e.target.value);const next=[...ordenForm.conceptos_fiscales];next[idx]={...x,id_concepto_fiscal:e.target.value,naturaleza:c?.naturaleza||"RETENCION",alicuota:c?.alicuota_default||""};setOrdenForm({...ordenForm,conceptos_fiscales:next})}}><option value="">Seleccionar...</option>{conceptos.map(c=><option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Field><Field label="Base"><input type="number" value={x.base_imponible} onChange={e=>{const n=[...ordenForm.conceptos_fiscales];n[idx]={...x,base_imponible:e.target.value};setOrdenForm({...ordenForm,conceptos_fiscales:n})}}/></Field><Field label="Alícuota %"><input type="number" value={x.alicuota} onChange={e=>{const n=[...ordenForm.conceptos_fiscales];n[idx]={...x,alicuota:e.target.value};setOrdenForm({...ordenForm,conceptos_fiscales:n})}}/></Field><Field label="Importe"><input type="number" value={x.importe} onChange={e=>{const n=[...ordenForm.conceptos_fiscales];n[idx]={...x,importe:e.target.value};setOrdenForm({...ordenForm,conceptos_fiscales:n})}}/></Field><Button danger onClick={()=>setOrdenForm({...ordenForm,conceptos_fiscales:ordenForm.conceptos_fiscales.filter((_,i)=>i!==idx)})}>×</Button></div>)}
        <div style={{display:"flex",justifyContent:"flex-end",gap:18,padding:12,background:"#11141c",borderRadius:7,marginBottom:14}}><span>Adiciones: <strong>$ {money(totalAdiciones)}</strong></span><span>Retenciones: <strong style={{color:"#e74c3c"}}>$ {money(totalRetenciones)}</strong></span><span>Neto a pagar: <strong style={{color:"#27ae60",fontSize:16}}>$ {money(neto)}</strong></span></div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"12px 0 8px"}}><h3 style={{fontSize:14}}>Liquidaciones a imputar (opcional)</h3><Button secondary onClick={()=>setOrdenForm({...ordenForm,aplicaciones:[...ordenForm.aplicaciones,{id_liquidacion:"",importe:""}]})}>+ Liquidación</Button></div>
        {ordenForm.aplicaciones.map((x,idx)=><div key={idx} style={{display:"grid",gridTemplateColumns:"2fr 1fr auto",gap:8,alignItems:"end",marginBottom:8}}><Field label="Liquidación"><select value={x.id_liquidacion} onChange={e=>{const n=[...ordenForm.aplicaciones];n[idx]={...x,id_liquidacion:e.target.value};setOrdenForm({...ordenForm,aplicaciones:n})}}><option value="">Seleccionar...</option>{liquidaciones.filter(l=>String(l.id_contraparte)===String(ordenForm.id_contraparte)&&l.estado!=="PAGADA").map(l=><option key={l.id} value={l.id}>{l.nro_liquidacion} · $ {money(l.monto_neto_a_pagar)}</option>)}</select></Field><Field label="Importe"><input type="number" value={x.importe} onChange={e=>{const n=[...ordenForm.aplicaciones];n[idx]={...x,importe:e.target.value};setOrdenForm({...ordenForm,aplicaciones:n})}}/></Field><Button danger onClick={()=>setOrdenForm({...ordenForm,aplicaciones:ordenForm.aplicaciones.filter((_,i)=>i!==idx)})}>×</Button></div>)}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"16px 0 8px"}}><h3 style={{fontSize:14}}>Instrumentos de pago</h3><Button secondary onClick={()=>setOrdenForm({...ordenForm,instrumentos:[...ordenForm.instrumentos,instrumentoVacio()]})}>+ Instrumento</Button></div>
        {ordenForm.instrumentos.map((i,idx)=><InstrumentoForm key={idx} item={i} index={idx} cuentas={cuentas} onChange={(n,v)=>{const next=[...ordenForm.instrumentos];next[n]=v;setOrdenForm({...ordenForm,instrumentos:next})}} onRemove={ordenForm.instrumentos.length>1?n=>setOrdenForm({...ordenForm,instrumentos:ordenForm.instrumentos.filter((_,i)=>i!==n)}):null}/>)}
        <div style={{textAlign:"right",color:Math.abs(ordenForm.instrumentos.reduce((s,i)=>s+Number(i.importe||0),0)-neto)<.001?"#27ae60":"#e74c3c"}}>Instrumentos: <strong>$ {money(ordenForm.instrumentos.reduce((s,i)=>s+Number(i.importe||0),0))}</strong> / Neto: <strong>$ {money(neto)}</strong></div>
      </Modal>}
      {detalle&&<OrdenDetalle orden={detalle} onClose={()=>setDetalle(null)}/>}
      {asignar&&<Modal title={`Imputar ${asignar.orden_numero}`} onClose={()=>setAsignar(null)} footer={<><Button secondary onClick={()=>setAsignar(null)}>Cancelar</Button><Button onClick={guardarAsignacion}>Confirmar imputación</Button></>} width={650}>{error&&<div className="alert-danger" style={{marginBottom:14}}>{error}</div>}<div className="alert-info" style={{marginBottom:14}}>{asignar.cheque_id?"Este cheque debe imputarse completo a un solo proveedor.":"Este instrumento permite imputaciones parciales hasta agotar el disponible."}</div><div className="form-grid-2"><Field label="Proveedor / receptor final"><select value={asignacion.id_contraparte_destino} onChange={e=>setAsignacion({...asignacion,id_contraparte_destino:e.target.value})}><option value="">Seleccionar...</option>{contrapartes.map(c=><option key={c.id} value={c.id}>{c.razon_social}</option>)}</select></Field><Field label="Fecha"><input type="date" value={asignacion.fecha} onChange={e=>setAsignacion({...asignacion,fecha:e.target.value})}/></Field><Field label="Importe"><input type="number" readOnly={!!asignar.cheque_id} value={asignacion.importe} onChange={e=>setAsignacion({...asignacion,importe:e.target.value})}/></Field><Field label="Concepto"><input value={asignacion.concepto} onChange={e=>setAsignacion({...asignacion,concepto:e.target.value})}/></Field><Field label="Quién entrega"><input value={asignacion.entregado_por} onChange={e=>setAsignacion({...asignacion,entregado_por:e.target.value})}/></Field><Field label="Quién recibe"><input value={asignacion.recibido_por} onChange={e=>setAsignacion({...asignacion,recibido_por:e.target.value})}/></Field></div></Modal>}
      {showCuenta&&<Modal title="Nueva cuenta bancaria" onClose={()=>setShowCuenta(false)} footer={<><Button secondary onClick={()=>setShowCuenta(false)}>Cancelar</Button><Button onClick={guardarCuenta}>Guardar cuenta</Button></>} width={650}>{error&&<div className="alert-danger" style={{marginBottom:14}}>{error}</div>}<div className="form-grid-2">{[["Nombre","nombre"],["Banco","banco"],["Tipo de cuenta","tipo_cuenta"],["Número de cuenta","numero_cuenta"],["CBU","cbu"],["Alias","alias"]].map(([l,k])=><Field key={k} label={l}><input value={cuentaForm[k]} onChange={e=>setCuentaForm({...cuentaForm,[k]:e.target.value})}/></Field>)}</div></Modal>}
      {showConcepto&&<Modal title="Nuevo concepto fiscal central" onClose={()=>setShowConcepto(false)} footer={<><Button secondary onClick={()=>setShowConcepto(false)}>Cancelar</Button><Button onClick={guardarConcepto}>Guardar concepto</Button></>} width={650}>{error&&<div className="alert-danger" style={{marginBottom:14}}>{error}</div>}<div className="form-grid-2"><Field label="Código"><input value={conceptoForm.codigo} onChange={e=>setConceptoForm({...conceptoForm,codigo:e.target.value})}/></Field><Field label="Nombre"><input value={conceptoForm.nombre} onChange={e=>setConceptoForm({...conceptoForm,nombre:e.target.value})}/></Field><Field label="Categoría"><select value={conceptoForm.categoria} onChange={e=>setConceptoForm({...conceptoForm,categoria:e.target.value})}>{["IVA","GANANCIAS","RETENCION_IVA","RETENCION_GANANCIAS","INGRESOS_BRUTOS","SUSS","OTRO"].map(x=><option key={x}>{x}</option>)}</select></Field><Field label="Naturaleza"><select value={conceptoForm.naturaleza} onChange={e=>setConceptoForm({...conceptoForm,naturaleza:e.target.value})}><option>ADICION</option><option>RETENCION</option><option>INFORMATIVO</option></select></Field><Field label="Alícuota predeterminada %"><input type="number" value={conceptoForm.alicuota_default} onChange={e=>setConceptoForm({...conceptoForm,alicuota_default:e.target.value})}/></Field></div></Modal>}
    </div>;
  };
})();
