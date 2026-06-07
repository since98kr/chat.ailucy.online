import React from 'react';
import { Link } from 'react-router-dom';

const Home: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#fdfbff] flex flex-col items-center justify-center p-6 font-sans">
      <div className="w-full max-w-2xl text-center mb-12">
        <h1 className="text-5xl font-bold mb-4 text-[#1b1b1f] tracking-tight">AI Chat Hub</h1>
        <p className="text-lg text-[#44464f]">
          Experience modern communication with Material 3 design.
          Select a workspace to begin.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-3xl">
        {/* OpenClaw Card - M3 Elevated Card style */}
        <Link
          to="/chat/openclaw"
          className="group relative bg-[#f3f0f5] hover:bg-[#e7e0eb] p-8 rounded-[28px] transition-all duration-300 shadow-sm hover:shadow-md border border-transparent hover:border-emerald-200 overflow-hidden"
        >
          <div className="flex flex-col h-full">
            <div className="w-14 h-14 bg-emerald-100 text-emerald-700 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
              <svg viewBox="0 0 24 24" className="w-8 h-8 fill-current">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-[#1b1b1f] mb-2">OpenClaw</h2>
            <p className="text-[#44464f] leading-relaxed">
              Global community for open-source AI development and research.
            </p>
            <div className="mt-auto pt-6 flex items-center text-emerald-700 font-semibold group-hover:translate-x-1 transition-transform">
              Enter Workspace
              <svg viewBox="0 0 24 24" className="w-5 h-5 ml-1 fill-current">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </div>
          </div>
        </Link>

        {/* Hermes Card - M3 Elevated Card style */}
        <Link
          to="/chat/hermes"
          className="group relative bg-[#f3f0f5] hover:bg-[#e7e0eb] p-8 rounded-[28px] transition-all duration-300 shadow-sm hover:shadow-md border border-transparent hover:border-violet-200 overflow-hidden"
        >
          <div className="flex flex-col h-full">
            <div className="w-14 h-14 bg-violet-100 text-violet-700 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
              <svg viewBox="0 0 24 24" className="w-8 h-8 fill-current">
                <path d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.09-.36.14-.57.14s-.41-.05-.57-.14l-7.9-4.44c-.31-.17-.53-.5-.53-.88v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.09.36-.14.57-.14s.41.05.57.14l7.9 4.44c.31.17.53.5.53.88v9zM12 4.15L6.04 7.5 12 10.85l5.96-3.35L12 4.15zM5 15.91l6 3.38v-6.71L5 9.21v6.7zm14 0v-6.7l-6 3.37v6.71l6-3.38z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-[#1b1b1f] mb-2">Hermes</h2>
            <p className="text-[#44464f] leading-relaxed">
              Secure gateway to advanced Hermes reasoning models and neural networks.
            </p>
            <div className="mt-auto pt-6 flex items-center text-violet-700 font-semibold group-hover:translate-x-1 transition-transform">
              Enter Workspace
              <svg viewBox="0 0 24 24" className="w-5 h-5 ml-1 fill-current">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </div>
          </div>
        </Link>
      </div>

      <footer className="mt-16 text-[#767680] text-sm font-medium">
        v3.0.0 "M3" Stable Release
      </footer>
    </div>
  );
};

export default Home;
