import React, { useState } from "react";

function App() {
  const [carrito, setCarrito] = useState([]);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");

  const productos = [
    { id: 1, nombre: "Merluza", precio: 10 },
    { id: 2, nombre: "Salmón", precio: 15 },
    { id: 3, nombre: "Calamares", precio: 12 }
  ];

  const agregarAlCarrito = (producto) => {
    setCarrito([...carrito, producto]);
  };

  const realizarPedido = () => {
    if (!nombre || !telefono) {
      alert("Por favor, introduce tu nombre y teléfono.");
      return;
    }
    console.log("Pedido realizado:", { nombre, telefono, carrito });
    alert("Pedido enviado con éxito.");
    setCarrito([]);
    setNombre("");
    setTelefono("");
  };

  return (
    <div className="p-4 font-sans">
      <h1 className="text-2xl mb-4">Catálogo de productos</h1>
      <div className="grid grid-cols-1 gap-4">
        {productos.map((prod) => (
          <div key={prod.id} className="border p-4 rounded shadow">
            <h2 className="text-xl">{prod.nombre}</h2>
            <p>Precio: ${prod.precio}</p>
            <button
              className="mt-2 bg-blue-500 text-white px-4 py-1 rounded"
              onClick={() => agregarAlCarrito(prod)}
            >
              Agregar
            </button>
          </div>
        ))}
      </div>
      <hr className="my-6" />
      <h2 className="text-xl">Carrito</h2>
      {carrito.length === 0 ? (
        <p>No hay productos en el carrito.</p>
      ) : (
        <ul className="list-disc pl-6">
          {carrito.map((item, i) => (
            <li key={i}>
              {item.nombre} - ${item.precio}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <input
          className="border p-2 mr-2"
          placeholder="Nombre"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
        />
        <input
          className="border p-2 mr-2"
          placeholder="Teléfono"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
        />
        <button
          className="bg-green-500 text-white px-4 py-2 rounded"
          onClick={realizarPedido}
        >
          Enviar pedido
        </button>
      </div>
    </div>
  );
}

export default App;